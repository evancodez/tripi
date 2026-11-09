// Listening to the whole song before a frame is drawn. Pure JavaScript, no DOM: it runs in a
// worker in the browser and in Node for tests.
//
//   analyze(pcm, sampleRate, onProgress) -> {
//     duration, bpm, meter,
//     beats, strong, bars            times in seconds (Float64Array)
//     sections: [{ t0, t1, bar0, bar1, label, energy, lift }]
//     fps, loud, loudSlow, bright, melody, melConf, bass, onset     curves at fps (Float32Array, 0..1 or -1..1)
//     chords: [{ t, root, minor, change }] per bar,  key: { tonic, minor }
//   }

const TAU = Math.PI * 2;

function fftSetup(n) {
  const rev = new Uint32Array(n), cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
  let bits = 0; while ((1 << bits) < n) bits++;
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b); rev[i] = r; }
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(TAU * i / n); sin[i] = Math.sin(TAU * i / n); }
  return { n, rev, cos, sin, re: new Float32Array(n), im: new Float32Array(n) };
}
function fft(S, input, win, off) {
  const { n, rev, cos, sin, re, im } = S;
  for (let i = 0; i < n; i++) { const j = rev[i]; re[j] = (input[off + i] || 0) * win[i]; im[j] = 0; }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const a = i + j, b = a + half;
        const tr = re[b] * cos[k] + im[b] * sin[k], ti = im[b] * cos[k] - re[b] * sin[k];
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
}

const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
function percentile(arr, q) {
  const s = Float32Array.from(arr).sort();
  return s[clamp(Math.round(q * (s.length - 1)), 0, s.length - 1)];
}
// one-pole smoothing forward and backward: no lag
function smooth(arr, tau) {
  const out = Float32Array.from(arr), k = 1 - Math.exp(-1 / Math.max(tau, 1e-6));
  for (let i = 1; i < out.length; i++) out[i] = out[i - 1] + (out[i] - out[i - 1]) * k;
  for (let i = out.length - 2; i >= 0; i--) out[i] = out[i + 1] + (out[i] - out[i + 1]) * k;
  return out;
}
function zscore(a) {
  let m = 0; for (const x of a) m += x; m /= a.length || 1;
  let v = 0; for (const x of a) v += (x - m) * (x - m); v = Math.sqrt(v / (a.length || 1)) || 1;
  return Float32Array.from(a, x => (x - m) / v);
}

export function analyze(pcmIn, srIn, onProgress = () => {}) {
  // ---- 1. half the sample rate: plenty for hearing structure, twice as fast
  let pcm = pcmIn, sr = srIn;
  if (srIn > 30000) {
    const n = pcmIn.length >> 1;
    pcm = new Float32Array(n);
    for (let i = 0; i < n; i++) pcm[i] = 0.5 * (pcmIn[2 * i] + pcmIn[2 * i + 1]);
    sr = srIn / 2;
  }
  const duration = pcm.length / sr;
  const N = 2048, hop = Math.round(sr / 100), fpsF = sr / hop;
  const T = Math.max(8, Math.floor((pcm.length - N) / hop));
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(TAU * i / (N - 1));
  const S = fftSetup(N);
  const half = N / 2, binHz = sr / N;

  // log-spaced bands
  const NB = 36, fLo = 40, fHi = sr * 0.45;
  const bandOf = new Int16Array(half + 1).fill(-1);
  for (let k = 1; k <= half; k++) {
    const f = k * binHz;
    if (f >= fLo && f < fHi) bandOf[k] = Math.min(NB - 1, Math.floor(NB * Math.log(f / fLo) / Math.log(fHi / fLo)));
  }
  const bandHz = b => fLo * Math.pow(fHi / fLo, (b + 0.5) / NB);
  let lowBands = 0; while (lowBands < NB && bandHz(lowBands) < 160) lowBands++;

  const bands = new Float32Array(T * NB);
  const flux = new Float32Array(T), lowFlux = new Float32Array(T), rms = new Float32Array(T), cent = new Float32Array(T), bassE = new Float32Array(T);
  const chroma = new Float32Array(T * 12);
  // melody salience: two bins a semitone from MIDI 50 to 88
  const P0 = 50, PB = 2, NPB = (88 - P0) * PB + 1;
  const sal = new Float32Array(T * NPB);
  const pcOf = new Int8Array(half + 1).fill(-1);
  for (let k = 1; k <= half; k++) { const f = k * binHz; if (f > 60 && f < 2100) pcOf[k] = ((Math.round(12 * Math.log2(f / 440)) % 12) + 12 + 9) % 12; }
  const mag = new Float32Array(half + 1), prev = new Float32Array(NB), cur = new Float32Array(NB);
  const k150 = Math.floor(150 / binHz), k4000 = Math.min(half - 2, Math.floor(4000 / binHz));

  for (let t = 0; t < T; t++) {
    if ((t & 1023) === 0) onProgress(0.75 * t / T);
    fft(S, pcm, win, t * hop);
    let e = 0, cn = 0, cd = 0, mx = 0;
    cur.fill(0);
    for (let k = 1; k <= half; k++) {
      const m = Math.hypot(S.re[k], S.im[k]) / (N / 4);
      mag[k] = m;
      e += m * m;
      const b = bandOf[k];
      if (b >= 0) { cur[b] += m * m; cn += m * Math.log2(k * binHz); cd += m; }
      if (pcOf[k] >= 0) chroma[t * 12 + pcOf[k]] += m * m;
      if (m > mx) mx = m;
    }
    rms[t] = Math.sqrt(e);
    cent[t] = cd > 1e-7 ? cn / cd : 0;
    let fl = 0, lf = 0, be = 0;
    for (let b = 0; b < NB; b++) {
      const L = Math.log(1 + 400 * Math.sqrt(cur[b]));
      bands[t * NB + b] = L;
      const d = L - prev[b];
      if (d > 0) { fl += d; if (b < lowBands) lf += d; }
      if (b < lowBands) be += cur[b];
      prev[b] = L;
    }
    flux[t] = fl; lowFlux[t] = lf; bassE[t] = Math.sqrt(be);
    // spectral peaks vote for the pitches they could be harmonics of
    const thr = mx * 0.06;
    for (let k = k150; k < k4000; k++) {
      const m = mag[k];
      if (m < thr || m <= mag[k - 1] || m < mag[k + 1]) continue;
      const a = mag[k - 1], c = mag[k + 1];
      const dk = 0.5 * (a - c) / (a - 2 * m + c || 1);
      const f = (k + dk) * binHz;
      for (let h = 1; h <= 6; h++) {
        const midi = 69 + 12 * Math.log2(f / h / 440);
        const x = (midi - P0) * PB;
        if (x < 0 || x > NPB - 1) continue;
        const i = Math.round(x), wgt = m * Math.pow(0.78, h - 1);
        sal[t * NPB + i] += wgt;
        if (i > 0) sal[t * NPB + i - 1] += wgt * 0.4;
        if (i < NPB - 1) sal[t * NPB + i + 1] += wgt * 0.4;
      }
    }
  }

  // ---- 2. loudness, brightness
  const db = Float32Array.from(rms, x => 20 * Math.log10(x + 1e-6));
  const dbHi = percentile(db, 0.97), dbLo = Math.max(percentile(db, 0.03), dbHi - 42);
  const loudRaw = Float32Array.from(db, x => clamp((x - dbLo) / (dbHi - dbLo || 1), 0, 1));
  const audible = Float32Array.from(cent).filter((_, i) => loudRaw[i] > 0.15);
  const cLo = percentile(audible.length ? audible : cent, 0.05), cHi = percentile(audible.length ? audible : cent, 0.95);
  const brightRaw = Float32Array.from(cent, x => clamp((x - cLo) / (cHi - cLo || 1), 0, 1));

  // ---- 3. beats
  onProgress(0.78);
  const fluxS = smooth(flux, 1.2);
  const fluxBase = smooth(flux, fpsF * 0.4);
  const onsetRaw = Float32Array.from(flux, (x, i) => Math.max(0, fluxS[i] - fluxBase[i]));
  const oz = zscore(onsetRaw);
  const lagMin = Math.round(fpsF * 60 / 210), lagMax = Math.round(fpsF * 60 / 55);
  const ac = new Float32Array(lagMax + 2);
  for (let lag = lagMin; lag <= lagMax + 1; lag++) {
    let s = 0; for (let i = lag; i < T; i++) s += oz[i] * oz[i - lag];
    ac[lag] = s / (T - lag);
  }
  let bestLag = lagMin, bestScore = -1e9;
  for (let lag = lagMin + 1; lag <= lagMax; lag++) {
    if (ac[lag] < ac[lag - 1] || ac[lag] < ac[lag + 1]) continue;
    const bpm = 60 * fpsF / lag;
    // people tap between about 80 and 150; lean that way, and reward lags whose double also lines up
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 112) / 0.55, 2));
    const dbl = lag * 2 <= lagMax ? Math.max(0, ac[lag * 2]) : 0;
    const sc = (ac[lag] + 0.5 * dbl) * prior;
    if (sc > bestScore) { bestScore = sc; bestLag = lag; }
  }
  {
    const a = ac[bestLag - 1], b = ac[bestLag], c = ac[bestLag + 1];
    var period = bestLag + 0.5 * (a - c) / (a - 2 * b + c || 1);
  }
  // dynamic programming: the best chain of beats about one period apart that lands on onsets
  const score = new Float32Array(T), back = new Int32Array(T).fill(-1);
  const tight = 6;
  const lo = Math.round(period * 0.5), hi = Math.round(period * 2);
  for (let t = 0; t < T; t++) {
    let best = 0, bi = -1;
    for (let d = lo; d <= hi && t - d >= 0; d++) {
      const lg = Math.log2(d / period);
      const v = score[t - d] - tight * lg * lg * 4;
      if (v > best) { best = v; bi = t - d; }
    }
    score[t] = oz[t] + best;
    back[t] = bi;
  }
  let end = T - 1;
  for (let t = Math.max(0, T - Math.round(period * 1.5)); t < T; t++) if (score[t] > score[end]) end = t;
  const beatFrames = [];
  for (let t = end; t >= 0; t = back[t]) beatFrames.push(t);
  beatFrames.reverse();
  // carry the grid out to both ends of the song so nothing is left unbarred
  while (beatFrames[0] - period > 0) beatFrames.unshift(beatFrames[0] - period);
  while (beatFrames[beatFrames.length - 1] + period < T) beatFrames.push(beatFrames[beatFrames.length - 1] + period);
  const frameT = f => (f * hop + N / 2) / sr;
  const beats = Float64Array.from(beatFrames, frameT);
  const NBt = beats.length;
  let bpm = 60 * fpsF / period;

  // ---- 4. bars: where the 1 is, and whether the song is in 3 or 4
  onProgress(0.84);
  const at = (arr, f, r) => { let m = 0; for (let i = Math.max(0, Math.round(f) - r); i <= Math.min(T - 1, Math.round(f) + r); i++) if (arr[i] > m) m = arr[i]; return m; };
  const beatLow = new Float32Array(NBt), beatOn = new Float32Array(NBt), beatCh = new Float32Array(NBt * 12), beatCn = new Float32Array(NBt);
  for (let i = 0; i < NBt; i++) {
    beatLow[i] = at(lowFlux, beatFrames[i], 4);
    beatOn[i] = at(onsetRaw, beatFrames[i], 4);
    const f0 = Math.max(0, Math.round(beatFrames[i])), f1 = Math.min(T, Math.round(i + 1 < NBt ? beatFrames[i + 1] : beatFrames[i] + period));
    let nrm = 0;
    for (let f = f0; f < f1; f++) for (let c = 0; c < 12; c++) beatCh[i * 12 + c] += chroma[f * 12 + c];
    for (let c = 0; c < 12; c++) nrm += beatCh[i * 12 + c] ** 2;
    nrm = Math.sqrt(nrm) || 1;
    for (let c = 0; c < 12; c++) beatCh[i * 12 + c] /= nrm;
    if (i > 0) { let dot = 0; for (let c = 0; c < 12; c++) dot += beatCh[i * 12 + c] * beatCh[(i - 1) * 12 + c]; beatCn[i] = 1 - dot; }
  }
  const zl = zscore(beatLow), zo = zscore(beatOn), zc = zscore(beatCn);
  const beatScore = Float32Array.from(zl, (x, i) => x + 0.8 * zc[i] + 0.4 * zo[i]);
  let meter = 4, phase = 0, bestC = -1e9;
  for (const M of [4, 3]) {
    for (let ph = 0; ph < M; ph++) {
      let a = 0, na = 0, b = 0, nb = 0;
      for (let i = 0; i < NBt; i++) { if (i % M === ph) { a += beatScore[i]; na++; } else { b += beatScore[i]; nb++; } }
      const c = (a / (na || 1) - b / (nb || 1)) * (M === 3 ? 0.8 : 1);
      if (c > bestC) { bestC = c; meter = M; phase = ph; }
    }
  }
  const barBeat = [];
  for (let i = phase; i < NBt; i += meter) barBeat.push(i);
  if (barBeat[0] > 0) barBeat.unshift(Math.max(0, barBeat[0] - meter));
  const bars = Float64Array.from(barBeat, i => beats[i]);
  const strongIdx = [];
  for (let i = 0; i < NBt; i++) { const pos = ((i - phase) % meter + meter) % meter; if (pos === 0 || (meter === 4 && pos === 2)) strongIdx.push(i); }
  const strong = Float64Array.from(strongIdx, i => beats[i]);

  // ---- 5. sections: bars that sound alike, and where the song turns
  onProgress(0.88);
  const NBar = bars.length, FD = 12 + 12 + 1;
  const barF = new Float32Array(NBar * FD), barLoud = new Float32Array(NBar), barBright = new Float32Array(NBar), barOn = new Float32Array(NBar);
  const meanBand = new Float32Array(NB);
  for (let t = 0; t < T; t++) for (let b = 0; b < NB; b++) meanBand[b] += bands[t * NB + b] / T;
  const tFrame = s => clamp(Math.round((s * sr - N / 2) / hop), 0, T - 1);
  for (let j = 0; j < NBar; j++) {
    const f0 = tFrame(bars[j]), f1 = Math.max(f0 + 1, tFrame(j + 1 < NBar ? bars[j + 1] : duration));
    const o = j * FD, n = f1 - f0;
    for (let f = f0; f < f1; f++) {
      for (let c = 0; c < 12; c++) barF[o + c] += chroma[f * 12 + c];
      for (let b = 0; b < NB; b++) barF[o + 12 + Math.floor(b / 3)] += (bands[f * NB + b] - meanBand[b]) / n / 3;
      barLoud[j] += loudRaw[f] / n; barBright[j] += brightRaw[f] / n; barOn[j] += onsetRaw[f] / n;
    }
    let nc = 0; for (let c = 0; c < 12; c++) nc += barF[o + c] ** 2; nc = Math.sqrt(nc) || 1;
    for (let c = 0; c < 12; c++) barF[o + c] /= nc;
    let nt = 0; for (let c = 12; c < 24; c++) nt += barF[o + c] ** 2; nt = Math.sqrt(nt) || 1;
    for (let c = 12; c < 24; c++) barF[o + c] = barF[o + c] / Math.max(nt, 0.6) * 1.2;
    barF[o + 24] = barLoud[j] * 2.2;
  }
  const dist = (a, b) => { let s = 0; for (let c = 0; c < FD; c++) { const d = barF[a * FD + c] - barF[b * FD + c]; s += d * d; } return Math.sqrt(s); };
  // novelty: how different the bars after a point are from the bars before it
  const K = 4, nov = new Float32Array(NBar);
  for (let j = 1; j < NBar; j++) {
    let cross = 0, within = 0, nc2 = 0, nw = 0;
    for (let a = 1; a <= K; a++) for (let b = 0; b < K; b++) {
      const ia = j - a, ib = j + b;
      if (ia < 0 || ib >= NBar) continue;
      const wgt = (1 - (a - 1) / K * 0.6) * (1 - b / K * 0.6);
      cross += wgt * dist(ia, ib); nc2 += wgt;
    }
    for (let a = 1; a <= K; a++) for (let b = a + 1; b <= K; b++) {
      if (j - b >= 0) { within += dist(j - a, j - b); nw++; }
      if (j + b - 1 < NBar) { within += dist(j + a - 1, j + b - 1); nw++; }
    }
    nov[j] = Math.max(0, cross / (nc2 || 1) - within / (nw || 1));
  }
  const novS = Float32Array.from(nov).sort();
  const novThr = novS[Math.floor(novS.length * 0.6)] * 1.15 + 1e-4;
  const minBars = Math.max(4, Math.round(8 / (60 / bpm * meter)));   // about 8 seconds
  let cuts = [];
  for (let j = 2; j < NBar - 2; j++) {
    if (nov[j] < novThr) continue;
    let peak = true;
    for (let d = -2; d <= 2; d++) if (d && nov[j + d] > nov[j]) peak = false;
    if (peak) cuts.push(j);
  }
  // keep the strongest when two are too close
  cuts.sort((a, b) => nov[b] - nov[a]);
  const kept = [];
  for (const c of cuts) if (kept.every(k => Math.abs(k - c) >= minBars) && c >= 2 && c <= NBar - 3) kept.push(c);
  kept.sort((a, b) => a - b);
  // the song proper: from the first bar with sound to the last
  const edges = [0, ...kept, NBar];
  const sections = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const b0 = edges[i], b1 = edges[i + 1];
    const mean = new Float32Array(FD); let ld = 0, br = 0, on = 0;
    for (let j = b0; j < b1; j++) { for (let c = 0; c < FD; c++) mean[c] += barF[j * FD + c] / (b1 - b0); ld += barLoud[j] / (b1 - b0); br += barBright[j] / (b1 - b0); on += barOn[j] / (b1 - b0); }
    sections.push({ bar0: b0, bar1: b1, t0: b0 === 0 ? 0 : bars[b0], t1: b1 < NBar ? bars[b1] : duration, mean, loud: ld, bright: br, density: on, nov: b0 ? nov[b0] : 0 });
  }
  // label: sections whose sound is close share a letter
  const LABEL_D = 0.6;
  const labels = [];
  for (const s of sections) {
    let best = -1, bd = 1e9;
    for (let l = 0; l < labels.length; l++) {
      let d = 0; for (let c = 0; c < FD; c++) d += (s.mean[c] - labels[l][c]) ** 2;
      d = Math.sqrt(d);
      if (d < bd) { bd = d; best = l; }
    }
    s.near = bd;
    if (best >= 0 && bd < LABEL_D) s.label = best; else { s.label = labels.length; labels.push(s.mean); }
  }
  // energy: half how loud the section is between the song's quiet and loud bars, half its rank among sections,
  // so a song mastered flat still has a shape
  const bl = Float32Array.from(barLoud).sort();
  const ldMin = bl[Math.floor(bl.length * 0.08)], ldMax = bl[Math.floor(bl.length * 0.95)];
  const dns = sections.map(s => s.density), dnMax = Math.max(...dns) || 1;
  const order = sections.map((s, i) => i).sort((a, b) => (sections[a].loud + 0.15 * sections[a].density / dnMax) - (sections[b].loud + 0.15 * sections[b].density / dnMax));
  const rank = []; order.forEach((si, r) => { rank[si] = sections.length > 1 ? r / (sections.length - 1) : 0.5; });
  sections.forEach((s, i) => {
    const l = clamp((s.loud - ldMin) / (ldMax - ldMin || 1), 0, 1);
    s.energy = clamp(0.5 * (0.75 * l + 0.25 * s.density / dnMax) + 0.5 * rank[i] * Math.min(1, l * 3), 0, 1);
    s.lift = i ? s.loud - sections[i - 1].loud : 0;       // how much louder than what came before
    delete s.mean;
  });

  // ---- 6. the tune: the smoothest loud path through the pitch salience
  onProgress(0.92);
  const MT = Math.floor(T / 2), fps = fpsF / 2;
  const pitch = new Float32Array(MT), conf = new Float32Array(MT);
  {
    const sc = new Float32Array(MT * NPB), bk = new Int16Array(MT * NPB);
    const frame = new Float32Array(NPB);
    const R = 8;
    for (let t = 0; t < MT; t++) {
      let mx = 1e-9;
      for (let i = 0; i < NPB; i++) { frame[i] = sal[2 * t * NPB + i] + sal[(2 * t + 1) * NPB + i]; if (frame[i] > mx) mx = frame[i]; }
      for (let i = 0; i < NPB; i++) {
        // lean toward the upper voices: the tune usually sits on top
        const v = frame[i] / mx * (0.8 + 0.4 * i / NPB) * loudRaw[2 * t];
        if (t === 0) { sc[i] = v; continue; }
        let best = -1e9, bi = i;
        for (let d = -R; d <= R; d++) {
          const j = i + d; if (j < 0 || j >= NPB) continue;
          const c = sc[(t - 1) * NPB + j] - 0.035 * Math.abs(d) - (d ? 0.02 : 0);
          if (c > best) { best = c; bi = j; }
        }
        sc[t * NPB + i] = v + best * 0.985; bk[t * NPB + i] = bi;
      }
    }
    let bi = 0; for (let i = 1; i < NPB; i++) if (sc[(MT - 1) * NPB + i] > sc[(MT - 1) * NPB + bi]) bi = i;
    for (let t = MT - 1; t >= 0; t--) {
      pitch[t] = P0 + bi / PB;
      let mx = 1e-9, sum = 0;
      for (let i = 0; i < NPB; i++) { const v = sal[2 * t * NPB + i]; sum += v; if (v > mx) mx = v; }
      conf[t] = clamp(sal[2 * t * NPB + bi] / mx, 0, 1) * clamp(loudRaw[2 * t] * 3, 0, 1);
      if (t > 0) bi = bk[t * NPB + bi];
    }
  }
  const dec = a => { const o = new Float32Array(MT); for (let t = 0; t < MT; t++) o[t] = 0.5 * (a[2 * t] + a[2 * t + 1]); return o; };
  const pitchMed = smooth(pitch, fps * 6);
  const melRaw = Float32Array.from(pitch, (p, t) => clamp((p - pitchMed[t]) / 7, -1, 1));
  const melConf = smooth(conf, fps * 0.25);
  const melody = smooth(Float32Array.from(melRaw, (m, t) => m * clamp(melConf[t] * 1.6, 0, 1)), fps * 0.07);

  const loud = smooth(dec(loudRaw), fps * 0.12);
  const loudSlow = smooth(dec(loudRaw), fps * 2.5);
  const bright = smooth(dec(brightRaw), fps * 0.5);
  const bassD = dec(bassE), bHi = percentile(bassD, 0.98) || 1;
  const bass = smooth(Float32Array.from(bassD, x => clamp(x / bHi, 0, 1)), fps * 0.08);
  const onD = dec(onsetRaw), oHi = percentile(onD, 0.995) || 1;
  const onset = Float32Array.from(onD, x => clamp(x / oHi, 0, 1));

  // ---- 7. harmony: a chord for each bar, and the key
  onProgress(0.97);
  const tot = new Float32Array(12);
  const chords = [];
  let prevRoot = -1;
  for (let j = 0; j < NBar; j++) {
    const c = barF.subarray(j * FD, j * FD + 12);
    for (let k = 0; k < 12; k++) tot[k] += c[k] * barLoud[j];
    let best = -1e9, root = 0, minor = false;
    for (let r = 0; r < 12; r++) for (const mn of [false, true]) {
      const v = c[r] + 0.8 * c[(r + 7) % 12] + 0.7 * c[(r + (mn ? 3 : 4)) % 12] - 0.3 * c[(r + (mn ? 4 : 3)) % 12];
      if (v > best) { best = v; root = r; minor = mn; }
    }
    chords.push({ t: bars[j], root, minor, change: root !== prevRoot });
    prevRoot = root;
  }
  const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], MIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  let key = { tonic: 0, minor: false }, kb = -1e9;
  for (let r = 0; r < 12; r++) for (const mn of [false, true]) {
    const prof = mn ? MIN : MAJ; let v = 0;
    for (let k = 0; k < 12; k++) v += tot[(r + k) % 12] * prof[k];
    if (v > kb) { kb = v; key = { tonic: r, minor: mn }; }
  }

  onProgress(1);
  return { duration, bpm, meter, beats, strong, bars, sections, fps, loud, loudSlow, bright, melody, melConf, bass, onset, chords, key };
}
