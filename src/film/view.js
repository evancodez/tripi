// The view: how the camera looks at the ribbon. A view is a short vector of numbers; any two views
// can be blended and everything in between is still a seamless picture, because point charges are
// whole numbers and only their positions move.
//
//   p (screen, half-height 1)  ->  lens  ->  tilt  ->  w = a p + b
//   z = A w  -  sum q log(1 - kappa w)  +  D / (w - e)  -  z(reference point)
//   u = Re z is how far along the ribbon (the song) this pixel is from "now"; v = Im z is round it.

export const V = {
  A: 0,            // stream strength: 1 = the ribbon lying flat, 0 = pure tunnel
  ZOOM: 1,         // ln |a|
  ROT: 2,          // arg a
  PANX: 3, PANY: 4,
  TILT: 5,
  K1X: 6, K1Y: 7,  // source 1 (the future pours out of it): pole at w = 1 / kappa
  K2X: 8, K2Y: 9,  // source 2
  K3X: 10, K3Y: 11,// source 3
  KSX: 12, KSY: 13,// the sink (the past drains into it)
  DX: 14, DY: 15,  // doublet strength
  EX: 16, EY: 17,  // doublet position
  REFX: 18, REFY: 19, // the screen point that shows "now"
  LENS: 20,
  DUTY: 21,
  TWIST: 22,
  SPLIT: 23,       // how far the colour plates are out of register
  PLATE: 24,       // the direction they slip in
  N: 28,
};

export const FLAT = (() => { const s = new Float32Array(V.N); s[V.A] = 1; return s; })();

// z and nothing else, on the CPU, in doubles: used for the reference point and by the director for framing.
export function mapPoint(s, px, py, out) {
  const lens = 1 - s[V.LENS] * Math.exp(-1.6 * (px * px + py * py));
  px *= lens; py *= lens;
  const ty = 1 / Math.max(1 - s[V.TILT] * py, 0.05);
  px *= ty; py *= ty;
  const zoom = Math.exp(s[V.ZOOM]);
  const ar = zoom * Math.cos(s[V.ROT]), ai = zoom * Math.sin(s[V.ROT]);
  const wr = ar * px - ai * py + s[V.PANX], wi = ar * py + ai * px + s[V.PANY];
  let zr = s[V.A] * wr, zi = s[V.A] * wi;
  for (let j = 0; j < 4; j++) {
    const kr = s[V.K1X + 2 * j], ki = s[V.K1Y + 2 * j];
    if (kr === 0 && ki === 0) continue;
    const q = j === 3 ? -1 : 1;
    const tr = 1 - (kr * wr - ki * wi), ti = -(kr * wi + ki * wr);
    zr -= q * 0.5 * Math.log(Math.max(tr * tr + ti * ti, 1e-24));
    zi -= q * Math.atan2(ti, tr);
  }
  const dr = wr - s[V.EX], di = wi - s[V.EY];
  const dd = Math.max(dr * dr + di * di, 1e-12);
  zr += (s[V.DX] * dr + s[V.DY] * di) / dd;
  zi += (s[V.DY] * dr - s[V.DX] * di) / dd;
  out[0] = zr; out[1] = zi;
  return out;
}
