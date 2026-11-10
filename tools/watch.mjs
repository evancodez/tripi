// Watch a whole film with numbers: is anything flashing, flickering or jolting?
//
//   node tools/lab.mjs tools/watch.mjs --size 240,150 --song disclosure [--colour] [--fps 30] [--take 2]
//
// Draws the song's film frame by frame (no sound, faster than real time) and measures, on a 12 x 8 grid:
//   flash    the whole frame's brightness swinging by more than 0.25 within 0.2 s
//   flicker  any one cell going dark-light-dark more than twice in a second
//   jolt     a frame that differs from the last far more than the frames round it do
export default async ({ page, args, log }) => {
  const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
  const song = opt('song', 'disclosure'), fps = +opt('fps', 30), colour = args.includes('--colour') ? 1 : 0;
  await page.waitFor('window.tripi && window.tripi.ready');
  if (song !== 'idle') {
    await page.eval((s, take) => { if (take > 1) history.replaceState(null, '', '?take=' + take); tripi.loadUrl('media/' + s + '.mp3'); }, song, +opt('take', 1));
    await page.waitFor('window.tripi.song && !window.tripi.loading', 180000);
    await page.eval(() => tripi.pause());
  }
  const r = await page.eval(async (fps, colour, isIdle) => {
    const dur = isIdle ? 120 : tripi.song.duration, GX = 12, GY = 8;
    const n = Math.floor(dur * fps);
    const cells = new Float32Array(n * GX * GY), mean = new Float32Array(n), diff = new Float32Array(n);
    let prev = null, W = 0, H = 0;
    for (let f = 0; f < n; f++) {
      const px = tripi.grab(f / fps, colour);
      if (!W) { const c = document.getElementById('stage'); W = c.width; H = c.height; }
      const lum = new Float32Array(W * H);
      let m = 0;
      for (let i = 0, j = 0; i < lum.length; i++, j += 4) { lum[i] = (0.2126 * px[j] + 0.7152 * px[j + 1] + 0.0722 * px[j + 2]) / 255; m += lum[i]; }
      mean[f] = m / lum.length;
      for (let y = 0; y < H; y++) { const gy = Math.min(GY - 1, Math.floor(y * GY / H)); for (let x = 0; x < W; x++) cells[f * GX * GY + gy * GX + Math.min(GX - 1, Math.floor(x * GX / W))] += lum[y * W + x]; }
      const per = (W / GX) * (H / GY);
      for (let c = 0; c < GX * GY; c++) cells[f * GX * GY + c] /= per;
      if (prev) { let d = 0; for (let i = 0; i < lum.length; i++) d += Math.abs(lum[i] - prev[i]); diff[f] = d / lum.length; }
      prev = lum;
      if (f % 300 === 0) await new Promise(r => setTimeout(r, 0));
    }
    const mmss = t => Math.floor(t / 60) + ':' + (t % 60).toFixed(1).padStart(4, '0');
    // flashes
    const flashes = [], win = Math.round(fps * 0.2);
    for (let f = win; f < n; f++) { if (Math.abs(mean[f] - mean[f - win]) > 0.25 && (!flashes.length || f / fps - flashes[flashes.length - 1].t > 0.5)) flashes.push({ t: f / fps, d: mean[f] - mean[f - win] }); }
    // flicker: full dark-light-dark cycles per cell in any one second
    let worst = 0, worstAt = 0; const flick = [];
    for (let c = 0; c < GX * GY; c++) {
      let state = 0; const turns = [];
      for (let f = 0; f < n; f++) {
        const v = cells[f * GX * GY + c];
        const s = v > 0.62 ? 1 : v < 0.38 ? -1 : 0;
        if (s && s !== state) { if (state) turns.push(f); state = s; }
      }
      for (let i = 0, j = 0; i < turns.length; i++) {
        while (turns[i] - turns[j] > fps) j++;
        const k = i - j + 1;
        if (k > worst) { worst = k; worstAt = turns[i] / fps; }
        if (k > 4 && (!flick.length || turns[i] / fps - flick[flick.length - 1].t > 2)) flick.push({ t: turns[i] / fps, turns: k, cell: c });
      }
    }
    // jolts
    const jolts = [], half = Math.round(fps * 0.5);
    for (let f = half; f < n - half; f++) {
      const near = []; for (let k = -half; k <= half; k++) if (Math.abs(k) > 1) near.push(diff[f + k]);
      near.sort((a, b) => a - b);
      const med = near[near.length >> 1];
      if (diff[f] > 0.1 && diff[f] > med * 2.2 + 0.04) jolts.push({ t: f / fps, d: diff[f], med });
    }
    // how plainly the strong beats show: the change in the picture in the tenth of a second round each strong
    // beat, against the change half way between beats (1 = the beat is invisible)
    let on = 0, off = 0, nb = 0;
    const sb = isIdle ? [] : Array.from(tripi.film.strong);
    for (let k = 0; k + 1 < sb.length; k++) {
      const f0 = Math.round(sb[k] * fps), fm = Math.round((sb[k] + sb[k + 1]) / 2 * fps);
      if (f0 < 2 || fm + 2 >= n) continue;
      on += Math.max(diff[f0 - 1], diff[f0], diff[f0 + 1], diff[f0 + 2]); off += Math.max(diff[fm - 1], diff[fm], diff[fm + 1], diff[fm + 2]); nb++;
    }
    const ds = Array.from(diff).sort((a, b) => a - b);
    let still = 0, run = 0, longest = 0, longestAt = 0;
    for (let f = 1; f < n; f++) { if (diff[f] < 0.004) { run++; if (run > longest) { longest = run; longestAt = f / fps; } } else run = 0; }
    return {
      dur, frames: n, size: [W, H],
      meanLum: mean.reduce((a, b) => a + b, 0) / n, minLum: Math.min(...mean), maxLum: Math.max(...mean), minLumAt: mmss(mean.indexOf(Math.min(...mean)) / fps), maxLumAt: mmss(mean.indexOf(Math.max(...mean)) / fps),
      motion: { median: ds[n >> 1], p05: ds[Math.floor(n * 0.05)], p95: ds[Math.floor(n * 0.95)] },
      flashes: flashes.map(x => mmss(x.t) + ' ' + x.d.toFixed(2)),
      flickerWorstTurnsPerSecond: worst, flickerWorstAt: mmss(worstAt), flicker: flick.slice(0, 12).map(x => mmss(x.t) + ' turns ' + x.turns),
      flickerCount: flick.length,
      jolts: jolts.slice(0, 20).map(x => mmss(x.t) + ' d ' + x.d.toFixed(3) + ' vs ' + x.med.toFixed(3)), joltCount: jolts.length,
      longestStill: (longest / fps).toFixed(1) + ' s at ' + mmss(longestAt),
      beatContrast: nb ? +(on / off).toFixed(2) : null, strongBeats: nb,
    };
  }, fps, colour, song === 'idle');
  log(JSON.stringify(r, null, 1));
  log('page problems:', page.problems());
};
