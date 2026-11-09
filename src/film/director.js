// The director. Given what the listener heard, it makes the whole film before a frame is shown:
//
//   1. the flow      how fast the camera travels along the ribbon, walking to the strong beats
//   2. the ribbon    which pattern is painted where, with the tune, the tone and the hits drawn into it
//   3. the views     a camera path through tunnels, floors, dipoles and flowers, phrased to the song
//   4. the bake      everything sampled 60 times a second into flat tables
//
// Playing the film is then only a table lookup and one draw call. Pure JavaScript, no DOM.
import { PATTERNS } from './patterns.js';
import { buildRibbon } from './ribbon.js';
import { V, squeeze, park, pole } from './view.js';
import { MAXP } from '../gl/shader.js';

const TAU = Math.PI * 2;
const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
const lerp = (a, b, t) => a + (b - a) * t;
const ss = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

function rng(seed) {
  let s = seed >>> 0;
  const r = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  r.range = (a, b) => a + (b - a) * r();
  r.sign = () => r() < 0.5 ? -1 : 1;
  r.pick = arr => arr[Math.floor(r() * arr.length)];
  r.weighted = pairs => { let tot = 0; for (const p of pairs) tot += p[1]; let x = r() * tot; for (const p of pairs) { x -= p[1]; if (x <= 0) return p[0]; } return pairs[pairs.length - 1][0]; };
  return r;
}

// monotone cubic through keys: smooth, and never overshoots
function pchip(ts, ys) {
  const n = ts.length, d = new Float64Array(n), m = new Float64Array(n);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (ts[i + 1] - ts[i]);
  m[0] = 0; m[n - 1] = 0;
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else { const h0 = ts[i] - ts[i - 1], h1 = ts[i + 1] - ts[i]; const w1 = 2 * h1 + h0, w2 = h1 + 2 * h0; m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]); }
  }
  let k = 0;
  return t => {
    if (t <= ts[0]) return ys[0];
    if (t >= ts[n - 1]) return ys[n - 1];
    while (k < n - 2 && t > ts[k + 1]) k++;
    while (k > 0 && t < ts[k]) k--;
    const h = ts[k + 1] - ts[k], x = (t - ts[k]) / h, x2 = x * x, x3 = x2 * x;
    return (2 * x3 - 3 * x2 + 1) * ys[k] + (x3 - 2 * x2 + x) * h * m[k] + (-2 * x3 + 3 * x2) * ys[k + 1] + (x3 - x2) * h * m[k + 1];
  };
}

function smoothArr(arr, tauSamples) {
  const out = Float64Array.from(arr), k = 1 - Math.exp(-1 / Math.max(tauSamples, 1e-6));
  for (let i = 1; i < out.length; i++) out[i] = out[i - 1] + (out[i] - out[i - 1]) * k;
  for (let i = out.length - 2; i >= 0; i--) out[i] = out[i + 1] + (out[i] - out[i + 1]) * k;
  return out;
}

// ------------------------------------------------------------------ poses
// A pose is a full view vector. Poles are given where they should sit on screen; the ones not in use
// wait at infinity, the sources ahead of the stream and the sink behind it, so that when a tunnel
// comes into a flat view it rises from the direction we are already travelling in.
function blank(rot = 0, tilt = 0) {
  const s = new Float32Array(V.N);
  s[V.SROT] = rot; s[V.TILT] = tilt;
  for (let j = 0; j < 3; j++) park(-rot, s, V.P1R + 2 * j);
  park(-rot + Math.PI, s, V.PSR);
  return s;
}
const POSES = {
  // the ribbon lying flat, travelling toward `rot`; mag is how much ribbon fits in half the screen's height
  flat(o) { const s = blank(o.rot, o.tilt); s[V.SMAG] = o.mag; return s; },
  // looking down a tunnel whose far end sits at (cx, cy)
  tunnel(o) { const s = blank(o.rot, o.tilt); squeeze(o.cx, o.cy, s, V.P1R); return s; },
  // out of one hole and into another
  dipole(o) {
    const s = blank(o.rot, o.tilt);
    const x = o.d * Math.cos(o.th), y = o.d * Math.sin(o.th);
    squeeze(x + (o.ox || 0), y + (o.oy || 0), s, V.P1R); squeeze(-x + (o.ox || 0), -y + (o.oy || 0), s, V.PSR);
    return s;
  },
  // two or three tunnels opening like a flower
  flower(o) {
    const s = blank(o.rot, o.tilt);
    for (let j = 0; j < o.m; j++) squeeze(o.d * Math.cos(o.th + j * TAU / o.m), o.d * Math.sin(o.th + j * TAU / o.m), s, V.P1R + 2 * j);
    return s;
  },
  // a spring in a flat stream: the ribbon pours out of a point and joins the flow
  spring(o) { const s = blank(o.rot, o.tilt); s[V.SMAG] = o.mag; squeeze(o.cx, o.cy, s, V.P1R); return s; },
  // the stream parting round a disc
  disc(o) { const s = blank(o.rot, o.tilt); s[V.SMAG] = o.mag; s[V.DR] = o.r * o.r; s[V.EX] = o.cx; s[V.EY] = o.cy; return s; },
};

// ------------------------------------------------------------------ compose
export function compose(a, opts = {}) {
  const seed = (opts.seed ?? 1) + Math.round(a.duration * 1000) + a.beats.length * 7919;
  const R = rng(seed);
  const dur = a.duration;
  const C = (arr, t) => { const x = clamp(t * a.fps, 0, arr.length - 1.001), i = Math.floor(x); return arr[i] + (arr[i + 1] - arr[i]) * (x - i); };
  const drive = clamp(0.6 * clamp((a.bpm - 70) / 70, 0, 1) + 0.4 * clamp((a.busy - 0.06) / 0.08, 0, 1), 0, 1);
  const beatLen = 60 / a.bpm, barLen = beatLen * a.meter;
  const strongLen = a.meter === 3 ? barLen : beatLen * 2;

  // ---- scenes: sections, with the long ones cut at phrase points
  const scenes = [];
  for (const s of a.sections) {
    const nb = s.bar1 - s.bar0, len = s.t1 - s.t0;
    const want = Math.max(1, Math.round(len / clamp(16 - 5 * drive, 10, 16)));
    let per = Math.max(2, Math.round(nb / want));
    if (per >= 6 && per % 2) per++;
    for (let b = s.bar0, k = 0; b < s.bar1; b += per, k++) {
      const b1 = (s.bar1 - (b + per) < Math.max(2, per / 2)) ? s.bar1 : Math.min(s.bar1, b + per);
      const t0 = b === s.bar0 ? s.t0 : a.bars[b], t1 = b1 === s.bar1 ? s.t1 : a.bars[b1];
      scenes.push({ t0, t1, bar0: b, bar1: b1, energy: s.energy, bright: s.bright, label: s.label, first: k === 0, lift: k === 0 ? s.lift : 0, nov: k === 0 ? s.nov : 0 });
      if (b1 === s.bar1) break;
    }
  }
  while (scenes.length > MAXP - 1) {          // an unusually long song: merge the shortest neighbours
    let bi = 1; for (let i = 2; i < scenes.length; i++) if (!scenes[i].first && (scenes[bi].first || scenes[i].t1 - scenes[i].t0 < scenes[bi].t1 - scenes[bi].t0)) bi = i;
    if (scenes[bi].first) { bi = 1; for (let i = 2; i < scenes.length; i++) if (scenes[i].t1 - scenes[i].t0 < scenes[bi].t1 - scenes[bi].t0) bi = i; }
    scenes[bi - 1].t1 = scenes[bi].t1; scenes[bi - 1].bar1 = scenes[bi].bar1; scenes.splice(bi, 1);
  }
  const NS = scenes.length;

  // ---- the moments that matter: arrivals (the song lifts) ranked by how big
  const arrivals = scenes.map((s, i) => ({ i, w: i ? s.lift * (0.4 + s.energy) : 0 })).filter(x => x.w > 0.03).sort((x, y) => y.w - x.w);
  const big = new Set();
  for (const x of arrivals) {
    if (big.size >= Math.max(2, Math.round(dur / 55))) break;
    if ([...big].every(j => Math.abs(scenes[j].t0 - scenes[x.i].t0) > 20)) big.add(x.i);
  }
  scenes.forEach((s, i) => { s.big = big.has(i); });

  // ---- 1. the cast: which pattern each scene wears
  const n0 = drive < 0.35 ? 8 : drive < 0.6 ? 10 : 12;      // calmer songs get bigger, calmer shapes
  const POOL = {
    calm: [['rings', 3], ['rays', 2], ['spiral', 3], ['dots', 3], ['net', 2], ['bars', 2], ['diamond', 2], ['hex', 2]],
    mid: [['checks', 3], ['diamond', 2], ['hex', 2], ['petal', 3], ['whirl', 3], ['harlequin', 3], ['spiral', 2], ['dots', 2], ['tri', 2], ['bars', 1]],
    high: [['tri', 3], ['harlequin', 3], ['checks', 3], ['whirl', 3], ['petal', 2], ['moire', 2], ['quasi', 1], ['diamond', 1]],
  };
  const home = new Map();
  const labelCount = new Map();
  for (const s of scenes) if (s.first) labelCount.set(s.label, (labelCount.get(s.label) || 0) + 1);
  let prev = '', prev2 = '';
  const makePattern = (name, s) => {
    const fine = R() < (s.bright - 0.5) * 0.9 + (s.energy > 0.8 ? 0.08 : 0);
    let n = fine ? n0 * 2 : n0;
    switch (name) {
      case 'spiral': return PATTERNS.spiral(n, n, R.sign());
      case 'dots': return PATTERNS.dots(n, n, R.range(0.2, 0.34) * R.weighted([[1, 2], [-1, 2]]));
      case 'hex': return PATTERNS.hex(n, R.weighted([[0.2, 2], [-0.12, 2]]));
      case 'moire': return PATTERNS.moire(n0 * 3, n0 * 3, R.pick([1, 2, 3]), R.pick([0, 0, n0 / 2]));
      case 'quasi': return PATTERNS.quasi(n0 * 1.5);
      case 'bars': return PATTERNS.bars(n0, n0);
      case 'tri': return PATTERNS.tri(n);
      case 'whirl': return PATTERNS.whirl(n, n);
      default: return PATTERNS[name](n);
    }
  };
  scenes.forEach((s, i) => {
    const tier = s.energy < 0.34 ? 'calm' : s.energy < 0.72 ? 'mid' : 'high';
    let name;
    const h = home.get(s.label);
    if (s.first && h && h !== prev && labelCount.get(s.label) > 1) name = h;
    else {
      const pool = POOL[tier].filter(p => p[0] !== prev && p[0] !== prev2);
      name = R.weighted(pool);
      if (s.first && !h) home.set(s.label, name);
    }
    s.pattern = makePattern(name, s);
    s.name = name;
    prev2 = prev; prev = name;
  });
  // ---- 2. the flow
  const HZ = 240, NT = Math.ceil((dur + 1) * HZ) + 1;
  const base = new Float64Array(NT), depth = new Float64Array(NT);
  for (const s of scenes) {
    // The flow is locked to the song: a whole number of the pattern's own periods passes "now" on every
    // strong beat (or one every two, or two a beat), whichever is nearest the pace the scene's energy asks for.
    s.alpha = Math.max(...s.pattern.w.map(w => w.amp ? Math.abs(w.a) : 0)) || n0;
    const hz = 0.36 + 0.8 * s.energy * (0.45 + 0.55 * drive);
    let m = 1, bd = 1e9;
    for (const c of [0.25, 0.5, 1, 2]) { const d = Math.abs(Math.log(c / strongLen / hz)); if (d < bd) { bd = d; m = c; } }
    s.speed = m * (TAU / s.alpha) / strongLen;
    s.stride = 0.2 + 0.55 * s.energy * (0.4 + 0.6 * drive);
    for (let i = Math.floor(s.t0 * HZ); i < Math.min(NT, Math.ceil(s.t1 * HZ)); i++) { base[i] = s.speed; depth[i] = s.stride; }
  }
  for (let i = Math.ceil(dur * HZ) - 1; i < NT; i++) { base[i] = base[Math.max(0, Math.ceil(dur * HZ) - 2)]; depth[i] = 0; }
  const baseS = smoothArr(base, HZ * Math.min(1.2, barLen * 0.6)), depthS = smoothArr(depth, HZ * 0.8);
  // strong beats, thinned to the bar's 1 in quiet scenes
  const sceneAt = t => { let i = 0; while (i < NS - 1 && t >= scenes[i].t1) i++; return i; };
  const barSet = new Set(Array.from(a.bars, t => Math.round(t * 1000)));
  const strong = Array.from(a.strong).filter(t => { const s = scenes[sceneAt(t)]; return t < dur - 0.3 && (s.energy > 0.3 || barSet.has(Math.round(t * 1000))) && C(a.loud, t + 0.03) > 0.12; });
  const kick = new Float64Array(NT);
  for (const t of strong) {
    const amp = 0.55 + 0.45 * clamp(C(a.onset, t) * 1.5 + C(a.bass, t + 0.03), 0, 1);
    for (let i = Math.floor(t * HZ), j = 0; i < NT && j < HZ * 1.6; i++, j++) { const x = j / HZ; kick[i] += amp * (1 - Math.exp(-x / 0.045)) * Math.exp(-x / 0.24); }
  }
  const kickMean = smoothArr(kick, HZ * barLen * 0.5), kickSoft = smoothArr(kick, HZ * 0.07);
  // wind-up and release round the big arrivals; the long ease to a stop at the end
  const gate = new Float64Array(NT).fill(1), wind = new Float64Array(NT), rush = 0.5 + 1.2 * drive;
  for (const i of big) {
    const t0 = scenes[i].t0, w = Math.min(barLen * 2, 4, (scenes[i].t0 - scenes[i - 1].t0) * 0.6);
    for (let k = Math.max(0, Math.floor((t0 - w) * HZ)); k < Math.min(NT, Math.floor((t0 + 2.4) * HZ)); k++) {
      const t = k / HZ;
      if (t < t0) { const x = ss((t - (t0 - w)) / w); gate[k] *= 1 - 0.62 * x; wind[k] = Math.max(wind[k], x * x); }
      else { const x = t - t0; gate[k] *= 1 - 0.62 * Math.exp(-x / 0.1) + rush * (1 - Math.exp(-x / 0.12)) * Math.exp(-x / 0.7); }
    }
  }
  const tEnd = Math.max(dur - Math.min(6, dur * 0.1), 0);
  for (let k = Math.floor(tEnd * HZ); k < NT; k++) gate[k] *= 1 - 0.92 * ss((k / HZ - tEnd) / (dur - tEnd));
  const alphaT = new Float64Array(NT).fill(n0);
  for (const s of scenes) { for (let i = Math.floor(s.t0 * HZ); i < Math.min(NT, Math.ceil(s.t1 * HZ)); i++) alphaT[i] = Math.max(n0, s.alpha); }
  const alphaS = smoothArr(alphaT, HZ * 1.5);
  const U = new Float64Array(NT);
  for (let i = 1; i < NT; i++) {
    let v = baseS[i] * gate[i] * (1 + depthS[i] * clamp(kick[i] / (kickMean[i] + 0.08) - 1, -1, 2.5));
    // never so fast that a bold pattern strobes: nothing passes a point more than about 3 times a second
    v = Math.min(v, baseS[i] * 3, 3 * TAU / alphaT[i]);
    U[i] = U[i - 1] + Math.max(v, 0.01) / HZ;
  }
  const Uat = t => { const x = clamp(t * HZ, 0, NT - 1.001), i = Math.floor(x); return U[i] + (U[i + 1] - U[i]) * (x - i); };
  let tk = 0;
  const Tat = u => {                        // inverse, for painting: called with u rising
    if (u <= U[0]) return (u - U[0]) / Math.max(baseS[0], 0.05);
    if (u >= U[NT - 1]) return (NT - 1) / HZ + (u - U[NT - 1]) / 0.3;
    while (tk < NT - 2 && U[tk + 1] < u) tk++;
    while (tk > 0 && U[tk] > u) tk--;
    return (tk + (u - U[tk]) / Math.max(U[tk + 1] - U[tk], 1e-9)) / HZ;
  };

  // ---- 3. the ribbon: where each pattern is painted, and the song drawn into it
  const uEnd = Uat(dur);
  const entries = scenes.map((s, i) => ({
    pattern: s.pattern, u: Uat(s.t0),
    // a big arrival lands as a tight front; a phrase change is a long slow morph
    width: s.big ? 0.5 : s.first ? lerp(1.4, 0.8, s.energy) : lerp(2.6, 1.6, s.energy),
  }));

  // counterchange: black and white swap on the biggest arrivals; and through the peak scene of a driving
  // song they swap on every bar, so each bar is a ring you can see coming
  const flips = [];
  for (const i of big) flips.push(Uat(scenes[i].t0));
  if (drive > 0.5) {
    const peaks = scenes.map((s, i) => i).filter(i => scenes[i].energy > 0.78 && scenes[i].t1 - scenes[i].t0 > 8).sort((x, y) => scenes[y].energy - scenes[x].energy).slice(0, dur > 200 ? 2 : 1);
    for (const i of peaks) {
      const s = scenes[i]; s.rings = true;
      let cnt = 0;
      for (const t of a.bars) if (t > s.t0 + 0.1 && t < s.t1 - 0.1) { flips.push(Uat(t)); cnt++; }
      if (cnt % 2) flips.push(Uat(s.t1));         // leave the polarity as it was found
    }
  }
  flips.sort((x, y) => x - y);

  // the tune as sway, the tone and the hits as ink weight
  const melS = smoothArr(a.melody, a.fps * 0.3), melSlow = smoothArr(a.melody, a.fps * 0.55);
  const brS = smoothArr(a.bright, a.fps * 1.2);
  const swayAmp = 0.28 * Math.sqrt(12 / n0);
  const SWAY_K = { dots: 0.3, hex: 0.3, net: 0.3, tri: 0.6, quasi: 0.4 };   // round and pointed shapes keep their form
  const Wtex = 8192, uMin = -14, uMax = uEnd + 14;
  const swayArr = new Float64Array(Wtex), dutyArr = new Float64Array(Wtex);
  const du = (uMax - uMin) / (Wtex - 1);
  tk = 0;
  let si = 0;
  for (let i = 0; i < Wtex; i++) {
    const u = uMin + i * du, t = Tat(u);
    if (t < 0 || t > dur) continue;
    while (si < NS - 1 && t >= scenes[si].t1) si++;
    const mel = C(melSlow, t);
    const flowless = scenes[si].pattern.name === 'rings' || scenes[si].pattern.name === 'bars';
    swayArr[i] = swayAmp * mel * (SWAY_K[scenes[si].pattern.name] ?? 1);
    dutyArr[i] = clamp(-0.3 * (C(brS, t) - 0.5) + (flowless ? 0.3 * mel : 0), -0.42, 0.42);
  }
  // no lean steeper than about 23 degrees, so shapes sway but keep their form
  const maxStep = 0.42 * du;
  for (let i = 1; i < Wtex; i++) swayArr[i] = clamp(swayArr[i], swayArr[i - 1] - maxStep, swayArr[i - 1] + maxStep);
  for (let i = Wtex - 2; i >= 0; i--) swayArr[i] = clamp(swayArr[i], swayArr[i + 1] - maxStep, swayArr[i + 1] + maxStep);
  const idx = u => clamp(Math.round((u - uMin) / du), 0, Wtex - 1);
  const ribbon = buildRibbon({ W: Wtex, uMin, uMax, entries, duty: u => dutyArr[idx(u)], sway: u => swayArr[idx(u)], flips });

  // ---- 4. the views
  const aspect = opts.aspect || 1.6;
  const kinds = {
    calm: [['flat', 3], ['floor', 2.5], ['tunnel', 2.5], ['disc', 1.6], ['spring', 1.6], ['dipole', 1.2], ['big', 1.5]],
    mid: [['tunnel', 3], ['dipole', 2.4], ['flat', 1.6], ['floor', 2], ['flower', 1.6], ['spring', 1.6], ['disc', 1], ['fine', 1], ['whirlpool', 1.5]],
    high: [['tunnel', 3], ['flower', 2.6], ['dipole', 2.4], ['floor', 1.8], ['fine', 1.4], ['whirlpool', 2], ['flat', 1]],
  };
  let rot = R.range(0, TAU);          // carried between shots so the sheet never snaps round
  // flat views are sized in pattern periods per screen height: bold is 2 to 4, fine is 12
  const magFor = (periods, n) => periods * Math.PI / n;
  const poseFor = (kind, n) => {
    // returns [start, end]: the shot drifts from one to the other
    const dr = R.sign() * R.range(0.35, 0.9);
    switch (kind) {
      case 'flat': { const r0 = rot; rot += dr; return [POSES.flat({ mag: magFor(R.range(2.8, 5), n), rot: r0 }), POSES.flat({ mag: magFor(R.range(2.6, 5.5), n), rot })]; }
      case 'big': { const r0 = rot; rot += dr * 0.6; return [POSES.flat({ mag: magFor(1.9, n), rot: r0 }), POSES.flat({ mag: magFor(4, n), rot })]; }
      case 'fine': { const r0 = rot; rot += dr * 0.5; return [POSES.flat({ mag: magFor(8, n), rot: r0 }), POSES.flat({ mag: magFor(5, n), rot })]; }
      case 'floor': { const sg = R() < 0.8 ? 1 : -1; let r0 = -Math.PI / 2 * sg + R.range(-0.5, 0.5); r0 += Math.round((rot - r0) / TAU) * TAU; rot = r0 + dr * 0.5; return [POSES.flat({ mag: magFor(R.range(3.6, 5.5), n), rot: r0, tilt: sg * R.range(0.42, 0.52) }), POSES.flat({ mag: magFor(R.range(3.4, 5.8), n), rot, tilt: sg * R.range(0.34, 0.52) })]; }
      case 'tunnel': { const a0 = R.range(0, TAU), r1 = R.range(0, 0.3), r2 = R.range(0.1, 0.45), a1 = a0 + R.sign() * R.range(1, 2.5); return [POSES.tunnel({ cx: r1 * Math.cos(a0), cy: r1 * Math.sin(a0) * 0.7, rot }), POSES.tunnel({ cx: r2 * Math.cos(a1), cy: r2 * Math.sin(a1) * 0.7, rot })]; }
      case 'whirlpool': { const sg = R.sign(), a0 = R.range(0, TAU), r1 = R.range(0, 0.25); return [POSES.tunnel({ cx: r1 * Math.cos(a0), cy: 0.1 * sg, rot, tilt: sg * R.range(0.4, 0.55) }), POSES.tunnel({ cx: -r1 * Math.cos(a0), cy: 0.15 * sg, rot, tilt: sg * R.range(0.25, 0.5) })]; }
      // the source sits ahead and the sink behind, the sides each comes in from: a source and a sink must never
      // cross paths, because where they meet they cancel and the whole picture goes blank
      case 'dipole': { const th = -rot + R.range(-0.5, 0.5), d1 = R.range(0.55, 0.85), d2 = R.range(0.5, 0.9), th2 = th + R.sign() * R.range(0.5, 1.0); return [POSES.dipole({ d: d1, th, rot }), POSES.dipole({ d: d2, th: th2, rot, ox: R.range(-0.2, 0.2), oy: R.range(-0.1, 0.1) })]; }
      case 'flower': { const m = R() < 0.6 ? 3 : 2, th = R.range(0, TAU), th2 = th + R.sign() * R.range(0.5, 1.2); return [POSES.flower({ m, d: R.range(0.5, 0.75), th, rot }), POSES.flower({ m, d: R.range(0.4, 0.8), th: th2, rot })]; }
      case 'spring': { const mag = magFor(R.range(3.2, 5), n), r0 = rot; rot += dr * 0.4; const a0 = -r0 + R.range(-0.6, 0.6), a1 = a0 + R.sign() * R.range(0.4, 0.9); return [POSES.spring({ mag, rot: r0, cx: 0.8 * Math.cos(a0), cy: 0.6 * Math.sin(a0) }), POSES.spring({ mag: mag * 1.2, rot, cx: 0.35 * Math.cos(a1), cy: 0.35 * Math.sin(a1) })]; }
      case 'disc': { const mag = magFor(R.range(3.5, 5.5), n), r0 = rot; rot += dr * 0.3; const th = -r0 + R.range(-0.4, 0.4), y = R.range(-0.25, 0.25); return [POSES.disc({ mag, rot: r0, r: R.range(0.3, 0.42), cx: 0.9 * Math.cos(th), cy: 0.6 * Math.sin(th) }), POSES.disc({ mag, rot, r: R.range(0.34, 0.5), cx: -0.5 * Math.cos(th), cy: -0.4 * Math.sin(th) + y })]; }
    }
  };
  let lastKind = '', lastKind2 = '';
  const keysT = [], keysS = [];
  const addKey = (t, s) => { if (keysT.length && t <= keysT[keysT.length - 1] + 0.05) t = keysT[keysT.length - 1] + 0.05; keysT.push(t); keysS.push(s); };
  scenes.forEach((s, i) => {
    const tier = s.energy < 0.34 ? 'calm' : s.energy < 0.72 ? 'mid' : 'high';
    const nMax = Math.max(n0, ...s.pattern.w.map(w => Math.abs(w.n)), ...s.pattern.w.map(w => Math.abs(w.a) * 0.9));
    const isFine = nMax > n0 * 1.5;
    const pool = kinds[tier].filter(k => k[0] !== lastKind && k[0] !== lastKind2
      && !(isFine && (k[0] === 'fine' || k[0] === 'floor'))             // fine lines stay close to the camera
      && !(s.big && (k[0] === 'fine' || k[0] === 'flat' || k[0] === 'big' || k[0] === 'disc')));   // an arrival opens onto depth
    const even = Math.abs(s.pattern.cov0 - 0.5) < 0.12;
    let kind = i === 0 ? R.weighted([['flat', 2], ['big', 2], ['tunnel', 2], ['floor', 1]]) : R.weighted(pool);
    if (kind === 'big' && !even) kind = 'flat';
    lastKind2 = lastKind; lastKind = kind;
    s.kind = kind; s.nMax = nMax;
  });
  // a flat view is sized for the finest pattern that will cross it: its own and its neighbours'
  scenes.forEach((s, i) => { s.poses = poseFor(s.kind, Math.sqrt(s.nMax * Math.max(s.nMax, scenes[Math.max(0, i - 1)].nMax, scenes[Math.min(NS - 1, i + 1)].nMax))); });
  // How far apart two poses are, in pattern periods swept past the edge of the frame: a long way takes a long move,
  // so nothing ever rushes past fast enough to flicker.
  const poseDist = (p, q, n) => {
    let d = Math.abs(p[V.SMAG] - q[V.SMAG]) * n / TAU * 1.7 + Math.abs(p[V.TILT] - q[V.TILT]) * 5 + Math.abs(p[V.SROT] - q[V.SROT]) * Math.max(p[V.SMAG], q[V.SMAG]) * n / TAU * 1.2;
    for (let j = 0; j < 4; j++) { const r1 = p[V.P1R + 2 * j], r2 = q[V.P1R + 2 * j], dt = p[V.P1T + 2 * j] - q[V.P1T + 2 * j]; d += (Math.abs(r1 - r2) + Math.min(r1, r2, 0.7) * Math.min(Math.abs(dt), 2)) * 2.2; }
    return d + Math.abs(p[V.DR] - q[V.DR]) * 8;
  };
  scenes.forEach((s, i) => {
    const len = s.t1 - s.t0;
    // every move lands on the scene's first beat: the camera arrives as the pattern does
    const moveIn = i === 0 ? 0 : clamp(1.5 + 1.0 * poseDist(scenes[i - 1].poses[1], s.poses[0], Math.max(s.nMax, scenes[i - 1].nMax)), 4.5, Math.max(4.5, Math.min(10, (scenes[i - 1].t1 - scenes[i - 1].t0) * 0.72)));
    s.moveIn = moveIn;
  });
  scenes.forEach((s, i) => {
    const land = s.t0;
    const leave = Math.max(land + 0.3, (i + 1 < NS ? scenes[i + 1].t0 - scenes[i + 1].moveIn : dur));
    if (i === 0) addKey(-0.5, s.poses[0]);
    addKey(land, s.poses[0]);
    if (leave - land > 1.0) addKey(leave, s.poses[1]);
  });
  addKey(dur + 1, keysS[keysS.length - 1]);
  // pole angles go the short way round between keys; a pole at the very middle keeps the angle it came with
  for (let k = 1; k < keysS.length; k++) {
    for (let j = 0; j < 4; j++) {
      const o = V.P1T + 2 * j;
      if (keysS[k][V.P1R + 2 * j] < 0.02) keysS[k][o] = keysS[k - 1][o];
      else if (keysS[k - 1][V.P1R + 2 * j] < 0.02) { for (let q = k - 1; q >= 0 && keysS[q][V.P1R + 2 * j] < 0.02; q--) keysS[q][o] = keysS[k][o]; }
      keysS[k][o] -= Math.round((keysS[k][o] - keysS[k - 1][o]) / TAU) * TAU;
    }
  }
  // Between a tunnel and a flat view the stream leads: it is most of the way up before the tunnel has gone,
  // and holds until the tunnel has arrived. Otherwise, half way, there is too little of either and the
  // pattern swells until one stripe fills the frame.
  for (let k = keysS.length - 1; k >= 1; k--) {
    const p = keysS[k - 1], q = keysS[k], sp = p[V.SMAG], sq = q[V.SMAG];
    if ((sp < 0.02) === (sq < 0.02) || keysT[k] - keysT[k - 1] < 2) continue;
    const m = new Float32Array(V.N);
    for (let c = 0; c < V.N; c++) m[c] = 0.5 * (p[c] + q[c]);
    m[V.SMAG] = sp < sq ? lerp(sp, sq, 0.74) : lerp(sp, sq, 0.26);
    keysS.splice(k, 0, m); keysT.splice(k, 0, 0.5 * (keysT[k - 1] + keysT[k]));
  }
  const comp = [];
  for (let c = 0; c < V.N; c++) comp.push(pchip(keysT, keysS.map(s => s[c])));

  // ---- overlays in time: the lens push on strong beats, the twist of the harmony, spin
  const FPS = 60, NF = Math.ceil((dur + 0.5) * FPS) + 1;
  const twistT = new Float64Array(NT), spinRate = new Float64Array(NT);
  {
    const cof = c => { let x = ((c.root - a.key.tonic) * 7 % 12 + 12) % 12; if (x > 6) x -= 12; return x; };
    let ci = 0;
    for (let i = 0; i < NT; i++) {
      const t = i / HZ;
      while (ci < a.chords.length - 1 && a.chords[ci + 1].t <= t) ci++;
      twistT[i] = clamp(0.1 * cof(a.chords[ci]), -0.5, 0.5);
    }
    for (const s of scenes) {
      const r = R.sign() * R.range(0.05, 0.16) * (0.6 + 0.8 * s.energy) * (s.pattern.flow === 0 ? 1.8 : 1);
      for (let i = Math.floor(s.t0 * HZ); i < Math.min(NT, Math.ceil(s.t1 * HZ)); i++) spinRate[i] = r;
    }
  }
  // Twist has a long lever: far from "now" a small change swings the pattern a long way. So it is only
  // ever allowed to change slowly (a wind-up takes bars, and lets go over seconds), or the edges would flicker.
  const twistS = smoothArr(twistT, HZ * 0.6);
  const spinS = smoothArr(spinRate, HZ * 1.5);
  const spin = new Float64Array(NT);
  const melT = smoothArr(a.melody, a.fps * 1.0);
  const SLEW = 0.2 / HZ;
  let tw = twistS[0];
  for (let i = 1; i < NT; i++) {
    const t = i / HZ;
    const want = twistS[i] + 0.22 * C(melT, t) + 0.8 * wind[i];
    tw += clamp(want - tw, -SLEW, SLEW);
    twistS[i] = tw;
    spin[i] = spin[i - 1] + spinS[i] / HZ + tw * (U[i] - U[i - 1]);
  }

  const melNod = smoothArr(a.melody, a.fps * 0.22);
  const view = new Float32Array(NF * V.N), ucam = new Float64Array(NF), spinF = new Float64Array(NF);
  for (let f = 0; f < NF; f++) {
    const t = f / FPS, o = f * V.N, hi = Math.min(NT - 1, Math.round(t * HZ));
    for (let c = 0; c < V.N; c++) view[o + c] = comp[c](t);
    const e = scenes[sceneAt(t)].energy;
    view[o + V.LENS] += (0.03 + 0.07 * e * (0.4 + 0.6 * drive)) * clamp(kick[hi], 0, 1.3) - 0.07 * wind[hi] * (gate[hi] < 1 ? 1 : 0) + 0.1 * Math.max(0, gate[hi] - 1) / rush;
    view[o + V.TWIST] = twistS[hi];
    // the tune tips the whole picture: high notes lift the far edge, low ones let it fall
    view[o + V.TILT] += 0.15 * C(melNod, t);
    // the ink swells on each strong beat: every shape on screen at once, crisp, and back
    view[o + V.DUTY] = (0.05 + 0.1 * e * (0.4 + 0.6 * drive)) * clamp(kickSoft[hi], 0, 1.3);
    // colour: the plates sit nearly in register, slip apart as the song gets loud, and jump on the strong beats;
    // sized against the pattern, so fine patterns fringe instead of turning to confetti
    const lam = TAU / alphaS[hi];
    view[o + V.SPLIT] = lam * (0.22 + 0.75 * C(a.loudSlow, t) * e + 0.3 * Math.abs(C(melS, t)) + 0.4 * clamp(kickSoft[hi], 0, 1.2) * (0.3 + 0.7 * e));
    view[o + V.PLATE] = 0.05 * t + 2.2 * twistS[hi];
    ucam[f] = Uat(t); spinF[f] = spin[hi];
  }

  let closest = 1e9;
  {
    const po = new Float64Array(16);
    for (let f = 0; f < NF; f += 3) {
      const s = view.subarray(f * V.N, f * V.N + V.N);
      for (let j = 0; j < 4; j++) pole(s, j, po, j * 4);
      if (Math.hypot(po[12], po[13]) > 6) continue;
      for (let j = 0; j < 3; j++) closest = Math.min(closest, Math.hypot(po[12] - po[j * 4], po[13] - po[j * 4 + 1]));
    }
  }
  return {
    closest,
    duration: dur, fps: FPS, frames: NF, view, ucam, spin: spinF, ribbon, drive, n0,
    palette: (a.key.tonic + (a.key.minor ? 2 : 0) + (opts.seed ?? 1) - 1) % 4,
    strong: Float64Array.from(strong),
    scenes: scenes.map(s => ({ t0: s.t0, t1: s.t1, energy: s.energy, pattern: s.name, n: Math.max(...s.pattern.w.map(w => Math.abs(w.n))) || Math.round(s.pattern.w[0].a), kind: s.kind, big: s.big, rings: !!s.rings, speed: s.speed })),
  };
}

// Read the film at time t into `out` ({ view: Float32Array(V.N), ucam, spin }).
export function filmAt(film, t, out) {
  const x = clamp(t * film.fps, 0, film.frames - 1.001), i = Math.floor(x), fr = x - i;
  const a = i * V.N, b = a + V.N, v = film.view, o = out.view;
  for (let c = 0; c < V.N; c++) o[c] = v[a + c] + (v[b + c] - v[a + c]) * fr;
  out.ucam = film.ucam[i] + (film.ucam[i + 1] - film.ucam[i]) * fr;
  out.spin = film.spin[i] + (film.spin[i + 1] - film.spin[i]) * fr;
  return out;
}
