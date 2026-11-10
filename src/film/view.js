// The view: how the camera looks at the ribbon. A view is a short vector of numbers; any two views
// can be blended and everything in between is still a seamless picture, because the point charges
// are whole numbers and only their positions move.
//
//   p (screen, half-height 1)  ->  lens  ->  tilt
//   z = S p  -  sum q log(p_j - p)  +  S r^2 / (p - e)  -  now
//   u = Re z is how far along the ribbon (the song) this pixel is from "now"; v = Im z is round it.
//
// S is the stream (the ribbon lying flat: its size is the zoom, its angle the way we travel). The
// p_j are poles on screen: three sources the future pours out of (tunnels) and one sink the past
// drains into. A pole not in use waits at infinity. Poles are stored in polar form with the radius
// squeezed, r = d / (1 + d), so blending two views carries a pole on a spiral round the middle of
// the screen: evenly across it and then away, and one waiting at infinity stays there.

export const V = {
  SMAG: 0, SROT: 1,     // the stream: |S| and arg S
  TILT: 2,
  P1R: 3, P1T: 4,       // source 1: squeezed radius, angle
  P2R: 5, P2T: 6,       // source 2
  P3R: 7, P3T: 8,       // source 3
  PSR: 9, PST: 10,      // the sink
  DR: 11,               // doublet: the square of the disc's radius
  EX: 12, EY: 13,       // the disc's centre on screen
  LENS: 14,
  DUTY: 15,
  TWIST: 16,
  SPLIT: 17,            // how far the colour plates are out of register
  PLATE: 18,            // the direction they slip in
  B1X: 19, B1Y: 20, B1R: 21,   // a bubble: where it is on screen and how big (0 = none)
  B2X: 22, B2Y: 23, B2R: 24,   // a second one
  N: 26,
};
export const POLES = 4;
export const FAR = 0.9998;     // squeezed radius that stands for infinity

// put a pole at a screen point, or park it at infinity in direction th
export function squeeze(x, y, out, o) { const d = Math.hypot(x, y); out[o] = d / (1 + d); out[o + 1] = Math.atan2(y, x); }
export function park(th, out, o) { out[o] = FAR; out[o + 1] = th; }

// pole j of view s as the shader wants it: screen x, y, charge, and 1 / sqrt(1 + |p|^2)
export function pole(s, j, out, o) {
  const r = Math.min(Math.max(s[V.P1R + 2 * j], 0), FAR), d = r / (1 - r), th = s[V.P1T + 2 * j];
  out[o] = d * Math.cos(th); out[o + 1] = d * Math.sin(th); out[o + 2] = j === 3 ? -1 : 1; out[o + 3] = 1 / Math.sqrt(1 + d * d);
}

// Where "now" sits along u: the average of Re z round a circle of radius NOW_R at the middle of the
// screen, softened so it stays smooth while poles wander across that circle. A tunnel shows "now" as
// a ring about that far from its centre; a flat view shows it through the middle of the frame.
export const NOW_R = 0.55;
const tmp = new Float64Array(4);
export function nowU(s) {
  let u = 0;
  for (let j = 0; j < POLES; j++) {
    pole(s, j, tmp, 0);
    const p2 = tmp[0] * tmp[0] + tmp[1] * tmp[1];
    u -= tmp[2] * (0.5 * Math.log(NOW_R * NOW_R + p2) - 0.5 * Math.log(1 + p2));
  }
  return u;
}
