// The pattern library. There are four kinds of pattern (see the shader's field()):
//
//   waves     at most six waves in two groups:  g1 = c1 + waves 0..2,  g2 = c2 + waves 3..5,
//             field = mix(g1 + g2, g1 * g2, lam). With lam = 1 the groups multiply, which is the op-art XOR:
//             stripes times stripes is a checkerboard, exactly.
//   contour   stripes on a coordinate that four other waves have bent: liquid, marbled, never still
//   weave     tiles of quarter-circle rings that join into ribbons; tiles re-tie themselves on the beat
//   halftone  a grid of shapes whose size is itself a field; they swell on the beat
//
// A wave is cos(a u + n v + ph) with n a whole number, and a grid has a whole number of cells round the
// tunnel, so every pattern closes seamlessly. Paper is where the field is above the threshold b.
// Morphing between two patterns blends their fields, so one grows out of the other's shapes.

const NOWAVE = { a: 0, n: 0, ph: 0, amp: 0 };
const W = (a, n, amp = 1, ph = 0, rate = 0) => ({ a, n, ph, amp, rate });
const RAW = (x = 0, y = 0, z = 0, w = 0) => ({ raw: [x, y, z, w] });
const HP = -Math.PI / 2;   // cos(x - pi/2) = sin x

function make(name, g1, g2, o = {}) {
  const w = [];
  for (let i = 0; i < 3; i++) w.push(g1[i] || NOWAVE);
  for (let i = 0; i < 3; i++) w.push(g2[i] || NOWAVE);
  const p = { name, kind: 0, w, p: [o.c1 || 0, o.c2 ?? (g2.length ? 0 : 1), o.lam ?? 1], b: o.b || 0, flow: o.flow ?? 1 };
  cover(p);
  p.alpha = Math.max(...w.map(x => x.amp ? Math.abs(x.a) : 0));
  p.fine = Math.max(...w.map(x => x.amp ? Math.max(Math.abs(x.n), Math.abs(x.a) * 0.9) : 0));
  p.grain = p.fine;        // the size of the thing you see, as a wave number: what a view is framed by
  return p;
}

// Mean paper coverage, and how it changes with duty: used where the pattern is too fine to draw.
function cover(p) {
  let s = 12345;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const N = 1500, c = [0, 0, 0], d = [-0.25, 0, 0.25];
  for (let i = 0; i < N; i++) {
    const u = rnd() * 40, v = rnd() * 40;
    let g1 = p.p[0], g2 = p.p[1];
    for (let k = 0; k < 6; k++) {
      const w = p.w[k];
      if (!w.amp) continue;
      const x = w.amp * Math.cos(w.a * u + w.n * v + w.ph);
      if (k < 3) g1 += x; else g2 += x;
    }
    const f = (g1 + g2) * (1 - p.p[2]) + g1 * g2 * p.p[2] - p.b;
    for (let j = 0; j < 3; j++) if (f - d[j] > 0) c[j]++;
  }
  p.cov0 = c[1] / N;
  p.covSlope = (c[0] - c[2]) / N / 0.5;
}

// ---- the three newer kinds. r is a random number source (r(), r.range, r.sign, r.pick).

// Liquid stripes. (a, n) is the way the stripes run before they are bent; warp is how far they are bent
// (0.3 a gentle swell, 1 marbling); cross > 0 crosses them with a second set, a melting checkerboard.
export function contour(r, n0, o = {}) {
  const warp = o.warp ?? 0.5, sp = o.speed ?? 1;
  const a = o.a ?? n0, n = o.n ?? 0, k = Math.hypot(a, n) || n0;
  const lo = Math.max(1, Math.round(n0 / 6)), mid = Math.max(2, Math.round(n0 / 3));
  // four bends: big slow ones first, each acting on what the last one left
  const bend = (ka, kn, amp) => W(ka, kn, amp * warp * 6 / k, r.range(0, 6.28), r.sign() * r.range(0.12, 0.3) * sp);
  const w = [
    bend(r.range(0.5, 1.1), r.sign() * lo, 1.0),
    bend(r.range(1.2, 2.0), r.sign() * r.pick([0, lo]), 0.8),
    bend(r.range(2.0, 3.0), r.sign() * mid, 0.26),
    bend(r.range(2.6, 3.6), r.sign() * r.pick([lo, mid]), 0.13),
    W(a, n, 1, 0),
    o.cross ? W(-n, a, o.cross, 0) : NOWAVE,
  ];
  return { name: o.cross ? 'melt' : 'liquid', kind: 1, w, p: [0, 0, 0], b: o.b ?? 0, flow: a ? 1 : 0,
    cov0: 0.5, covSlope: o.cross ? 0.5 : 0.32, alpha: Math.abs(a) || n0, fine: k * (1 + warp * 0.8), grain: k, sway: 0.6 };
}

// The weave. N tiles round the tunnel; rings is how many ribbons cross each tile (1 or 3); every
// `every` beats a tile may re-tie itself, and it has finished doing so as the beat lands.
export function weave(r, N, o = {}) {
  const rings = o.rings ?? 1, sign = o.sign ?? 1;
  return { name: rings > 1 ? 'braid' : 'weave', kind: 2, p: [sign, 0, 0], b: o.b ?? (rings > 1 ? 0 : 0.5) * sign,
    w: [RAW(rings, o.every ?? 2, o.win ?? 0.3, 0), NOWAVE, NOWAVE, NOWAVE, NOWAVE, { grid: N, sigma: o.sigma ?? 0.35 }],
    flow: 1, cov0: 0.5 - 0.12 * sign * (rings > 1 ? 0 : 1), covSlope: 0.32, alpha: N, fine: N * rings * 1.15, grain: N * (rings > 1 ? 1.5 : 1), sway: 0.3 };
}

// The halftone. N shapes round the tunnel; radius 0.5 is where circles touch; rings > 0 turns each shape
// into a target that sends a ring outward every beat.
export function halftone(r, N, o = {}) {
  const sign = o.sign ?? 1, quin = o.quincunx ? 1 : 0, rings = o.rings ?? 0;
  const rad = (o.radius ?? 0.3) * (o.diamond && quin ? 0.68 : 1);      // diamonds on two grids meet sooner than circles do
  const wave = (amp) => W(r.range(0.5, 1.6) * r.sign(), r.sign() * r.pick([1, 2, 3]), amp, r.range(0, 6.28), r.sign() * r.range(0.1, 0.25));
  const area = (quin ? 2 : 1) * Math.PI * rad * rad;
  return { name: rings ? 'targets' : o.square > 0.5 ? 'blocks' : 'halftone', kind: 3, p: [sign, 0, 0], b: 0,
    w: [RAW(rad, o.square ?? 0, o.diamond ?? 0, rings), RAW(o.swell ?? 0.06, o.turn ?? 0, quin, o.emit ?? 1), wave(o.breathe ?? 0.07), wave((o.breathe ?? 0.07) * 0.6), NOWAVE, { grid: N, sigma: o.sigma ?? 0.35 }],
    flow: 1, cov0: rings ? 0.5 : sign > 0 ? Math.min(0.9, area) : 1 - Math.min(0.9, area), covSlope: 0.3, alpha: N, fine: N * (quin ? 1.45 : 1) * Math.max(1, rings * 2), grain: N * (quin ? 1.4 : 1) * (rings ? 1.3 : 1), sway: 0.3 };
}

// n: how many times the pattern repeats round the tunnel. a: the matching wave number along it.
// Square cells need a = n. period: the length along u after which the pattern repeats.
export const PATTERNS = {
  rings:     (n, a = n) => make('rings', [W(a, 0)], []),
  rays:      (n) => make('rays', [W(0, n)], [], { flow: 0 }),
  spiral:    (n, a = n, s = 1) => make('spiral', [W(a, s * n)], []),
  checks:    (n, a = n) => make('checks', [W(a, 0)], [W(0, n)]),
  harlequin: (n, a = n) => make('harlequin', [W(a, n)], [W(a, -n)]),
  dots:      (n, a = n, b = 0.42) => make('dots', [W(a, 0, 0.5), W(0, n, 0.5)], [], { b }),
  // three stripe sets at 60 degrees, multiplied: a field of triangles
  tri:       (n) => { const h = n * Math.sqrt(3) / 2; return make('tri', [W(0, n, 0.385, HP), W(h, -n / 2, 0.385, HP), W(-h, -n / 2, 0.385, HP)], []); },
  hex:       (n, b = 0.3) => { const h = n * Math.sqrt(3) / 2; return make('hex', [W(0, n, 1 / 3), W(h, n / 2, 1 / 3), W(h, -n / 2, 1 / 3)], [], { b }); },
  // two fine gratings that nearly agree: the picture is their beat
  moire:     (n, a = n, dn = 2, da = 0) => make('moire', [W(a, n)], [W(-a - da, n + dn)]),
  // rings at two scales multiplied: bars that break into a rhythm
  bars:      (n, a = n) => make('bars', [W(a, 0)], [W(a * 3, 0, 1)], {}),
  // spiral arms against rings
  whirl:     (n, a = n) => make('whirl', [W(a, n)], [W(a * 2, 0)]),
  // spiral arms against rays: petals
  petal:     (n, a = n) => make('petal', [W(a, n)], [W(0, n * 2)]),
  // five directions: order with no repeat
  quasi:     (n) => {
    const g = [];
    for (let j = 0; j < 5; j++) { const th = j * Math.PI / 5; g.push(W(n * Math.cos(th), Math.round(n * Math.sin(th)), 0.2)); }
    return make('quasi', g.slice(0, 3), g.slice(3), { lam: 0, c2: 0 });
  },
  // a net: thin lines round fat cells
  net:       (n, a = n) => make('net', [W(a, 0, 0.5), W(0, n, 0.5)], [], { b: -0.55 }),
  // diamonds that are really two rings and rays summed
  diamond:   (n, a = n) => make('diamond', [W(a, 0, 0.5), W(0, n, 0.5)], []),
};

export function pattern(name, ...args) { return PATTERNS[name](...args); }
