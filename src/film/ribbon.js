// The ribbon: the whole song painted along one strip. Each texel along u holds
//   r: pattern position (k + m: entry k morphing into entry k + 1 by m)
//   g: duty (ink weight)
//   b: sway (the ribbon slides sideways: this is where the tune is drawn)
//   a: signed distance, in u, to the nearest counterchange edge (black and white swap sides there)

const smooth = x => x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (6 * x - 15) + 10);

// entries: [{ pattern, u, width }] in order; entry 0 covers everything before entry 1's morph.
// duty, sway: functions of u (or null). flips: sorted u positions of counterchange edges.
export function buildRibbon({ W = 8192, uMin, uMax, entries, duty = null, sway = null, flips = [] }) {
  const data = new Float32Array(W * 4);
  const scale = (W - 1) / (uMax - uMin);
  // keep morphs from overlapping
  const tr = [];
  for (let k = 1; k < entries.length; k++) {
    const e = entries[k];
    let a = e.u - e.width / 2, b = e.u + e.width / 2;
    if (tr.length && a < tr[tr.length - 1].b) a = tr[tr.length - 1].b;
    if (b < a + 1e-3) b = a + 1e-3;
    tr.push({ a, b });
  }
  let k = 0, fi = 0;
  for (let i = 0; i < W; i++) {
    const u = uMin + i / scale;
    while (k < tr.length && u >= tr[k].b) k++;
    let P = k;
    if (k < tr.length && u > tr[k].a) P = k + smooth((u - tr[k].a) / (tr[k].b - tr[k].a));
    if (P > entries.length - 1) P = entries.length - 1;
    while (fi < flips.length && flips[fi] <= u) fi++;
    const sign = fi % 2 ? -1 : 1;
    let dist = 1;
    if (fi > 0) dist = Math.min(dist, u - flips[fi - 1]);
    if (fi < flips.length) dist = Math.min(dist, flips[fi] - u);
    const o = i * 4;
    data[o] = P;
    data[o + 1] = duty ? duty(u) : 0;
    data[o + 2] = sway ? sway(u) : 0;
    data[o + 3] = sign * Math.max(dist, 1e-6);
  }
  return { W, data, u0: uMin, scale, patterns: entries.map(e => e.pattern) };
}
