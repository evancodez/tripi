// The pattern library. A pattern is at most six waves on the ribbon, in two groups:
//
//   g1 = c1 + sum of waves 0..2        g2 = c2 + sum of waves 3..5
//   field = mix(g1 + g2, g1 * g2, lam) - b          paper where field > 0, ink where field < 0
//
// A wave is cos(a u + n v + ph) with n a whole number, so every pattern closes seamlessly round a
// tunnel. With lam = 1 the two groups multiply, which is the op-art XOR: stripes times stripes is
// a checkerboard, exactly. Morphing between two patterns blends the groups, so shared waves carry
// straight through and new ones open as slivers inside the old shapes.

const NOWAVE = { a: 0, n: 0, ph: 0, amp: 0 };
const W = (a, n, amp = 1, ph = 0) => ({ a, n, ph, amp });
const HP = -Math.PI / 2;   // cos(x - pi/2) = sin x

function make(name, g1, g2, o = {}) {
  const w = [];
  for (let i = 0; i < 3; i++) w.push(g1[i] || NOWAVE);
  for (let i = 0; i < 3; i++) w.push(g2[i] || NOWAVE);
  const p = { name, w, c1: o.c1 || 0, c2: o.c2 ?? (g2.length ? 0 : 1), lam: o.lam ?? 1, b: o.b || 0, flow: o.flow ?? 1 };
  cover(p);
  return p;
}

// Mean paper coverage, and how it changes with duty: used where the pattern is too fine to draw.
function cover(p) {
  let s = 12345;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const N = 1500, c = [0, 0, 0], d = [-0.25, 0, 0.25];
  for (let i = 0; i < N; i++) {
    const u = rnd() * 40, v = rnd() * 40;
    let g1 = p.c1, g2 = p.c2;
    for (let k = 0; k < 6; k++) {
      const w = p.w[k];
      if (!w.amp) continue;
      const x = w.amp * Math.cos(w.a * u + w.n * v + w.ph);
      if (k < 3) g1 += x; else g2 += x;
    }
    const f = (g1 + g2) * (1 - p.lam) + g1 * g2 * p.lam - p.b;
    for (let j = 0; j < 3; j++) if (f - d[j] > 0) c[j]++;
  }
  p.cov0 = c[1] / N;
  p.covSlope = (c[0] - c[2]) / N / 0.5;
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
