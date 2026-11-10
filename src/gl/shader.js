// The one shader. Everything tripi draws comes out of this single program, driven only by uniforms,
// so nothing is ever compiled while a song plays.
//
// The picture is the sign of a field made of a few interfering waves that live on "the ribbon":
// an endless strip of pattern with the whole song painted along its length (u) and wrapped round
// its width (v, period 2*pi). The camera looks at the ribbon through a conformal map built like a
// 2D potential flow: a uniform stream (the ribbon lying flat) plus point sources and sinks (the
// ribbon rolled into tunnels) plus a doublet (the ribbon flowing round a disc). Because the map
// is conformal, squares stay square however the ribbon is bent. See film/view.js.

export const MAXP = 48;        // ribbon entries (patterns in order of appearance)
export const WAVES = 6;        // waves per pattern: 0..2 in group 1, 3..5 in group 2
export const POLES = 4;

export const VERT = `#version 300 es
void main() {
  // one triangle that covers the screen
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform vec2 uRes;
uniform sampler2D uRibbon;            // W x 1, RGBA32F: pattern position, duty, sway, signed distance to a polarity flip
uniform vec4 uRib;                    // x0 (texel of u = 0), texels per unit u, W - 1, -
uniform vec4 uWave[${MAXP * WAVES}];  // six slots a pattern: a wave (alpha, n, phase, amplitude) or whatever its kind needs
uniform vec4 uPat[${MAXP}];           // kind, and three numbers its kind needs
uniform vec4 uPat2[${MAXP}];          // mean coverage at duty 0, coverage slope, finest wave number, threshold
uniform vec4 uBub[2];                 // bubbles: centre on screen, radius, how strongly it bulges
uniform vec4 uBeat;                   // strong-beat count (whole on each strong beat), twist, seconds, -
uniform vec4 uStream;                 // S (complex), tilt, lens
uniform vec4 uPole[${POLES}];         // p_j (screen), charge q, 1 / sqrt(1 + |p_j|^2): z -= q log(p_j - p)
uniform vec4 uDbl;                    // D (complex), e (screen): z += D / (p - e)
uniform vec4 uRef;                    // u of "now", -, global duty, -
uniform vec4 uPlate[3];               // per ink: screen offset (xy), offset along u, twist
uniform vec3 uInk[3];
uniform vec3 uPaper;
uniform vec4 uMode;                   // colour amount (0 = one black plate), -, -, -
uniform vec4 uRec;                    // record: blend B, u of the song's start, u per e-fold of radius, -
uniform vec4 uRec2;                   // record: how many times finer the lattice is (K), rim radius, u of the song's end, edge offset

out vec4 outColor;

vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
vec2 cdiv(vec2 a, vec2 b) { return vec2(a.x * b.x + a.y * b.y, a.y * b.x - a.x * b.y) / max(dot(b, b), 1e-12); }
vec2 clog(vec2 a) { return vec2(0.5 * log(max(dot(a, a), 1e-24)), atan(a.y, a.x)); }

const float TAU = 6.28318530718;
float hash21(vec2 p) { p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.y); }
// a swell that peaks exactly on the beat: it gathers just before, and falls away after
float pulse(float ph) { float f = fract(ph); return max(exp(-f * 5.0), smoothstep(0.86, 1.0, f)); }
// a staircase that climbs one step a beat and is already standing on the new step when the beat lands
float stair(float ph, float w) { float e = floor(ph); return e + smoothstep(1.0 - w, 1.0, ph - e); }

// One shape of the halftone grid: how far this point is from the middle of its cell (in the shape's own
// measure: round, square or diamond), the beat as that cell hears it, and how much it swells on it.
vec3 shape(vec2 c, float off, vec4 w0, vec4 w1, vec4 w5) {
  vec2 cell = floor(c), q = c - cell - 0.5;
  float ph = uBeat.x + w5.w * (cell.x + 0.5 - off - w5.y) * TAU / w5.x;
  float th = 1.5707963 * w1.y * stair(ph, 0.4), cs = cos(th), sn = sin(th);
  q = vec2(cs * q.x - sn * q.y, sn * q.x + cs * q.y);
  vec2 aq = abs(q);
  float d = mix(length(q), max(aq.x, aq.y), w0.y);
  // neighbours swell and shrink in turn, so the beat trades size between them and the frame never brightens or dims
  float sgn = w1.z > 0.5 ? (off > 0.25 ? -1.0 : 1.0) : (mod(cell.x + cell.y, 2.0) < 0.5 ? 1.0 : -1.0);
  return vec3(mix(d, (aq.x + aq.y) * 0.7071, w0.z), ph, sgn * w1.x * pulse(ph));
}

// The field of pattern k at ribbon point (u, v): paper where it is above the pattern's threshold, ink below.
// Four kinds of pattern, all closing seamlessly round a tunnel:
//   0 waves     a few interfering waves, in two groups that add or multiply (stripes, checks, triangles, moire)
//   1 contour   stripes carried on a coordinate that other waves have bent: liquid, marbled, alive
//   2 weave     a grid of tiles, each two quarter-circles of rings; tiles re-tie themselves on the beat
//   3 halftone  a grid of shapes (dots, squares, diamonds, targets) whose size is a field: they swell on the beat
float field(int k, float u, float v) {
  int b = k * ${WAVES};
  vec4 P = uPat[k];
  vec4 w0 = uWave[b], w1 = uWave[b + 1], w2 = uWave[b + 2];
  vec4 w3 = uWave[b + 3], w4 = uWave[b + 4], w5 = uWave[b + 5];
  if (P.x < 0.5) {
    float g1 = P.y + w0.w * cos(w0.x * u + w0.y * v + w0.z)
                   + w1.w * cos(w1.x * u + w1.y * v + w1.z)
                   + w2.w * cos(w2.x * u + w2.y * v + w2.z);
    float g2 = P.z + w3.w * cos(w3.x * u + w3.y * v + w3.z)
                   + w4.w * cos(w4.x * u + w4.y * v + w4.z)
                   + w5.w * cos(w5.x * u + w5.y * v + w5.z);
    return mix(g1 + g2, g1 * g2, P.w);
  }
  if (P.x < 1.5) {
    vec2 q = vec2(u, v);
    q.y += w0.w * sin(w0.x * q.x + w0.y * q.y + w0.z);
    q.x += w1.w * sin(w1.x * q.x + w1.y * q.y + w1.z);
    q.y += w2.w * sin(w2.x * q.x + w2.y * q.y + w2.z);
    q.x += w3.w * sin(w3.x * q.x + w3.y * q.y + w3.z);
    return cos(w4.x * q.x + w4.y * q.y + w4.z) * mix(1.0, cos(w5.x * q.x + w5.y * q.y + w5.z), w5.w);
  }
  // the grid: w5 = cells round the tunnel, the camera's place in cells (u, v), how fast a beat travels along u
  float cu = TAU / w5.x;
  vec2 c = vec2(u, v) / cu + w5.yz;
  if (P.x < 2.5) {
    // w0 = rings per tile, tiles re-tie every so many beats, how late in the beat the re-tying starts, -
    vec2 cell = floor(c), fr = c - cell;
    vec2 id = vec2(cell.x, mod(cell.y, w5.x));
    float ph = uBeat.x + w5.w * (cell.x + 0.5 - w5.y) * cu;
    float x = (ph - floor(hash21(id + 7.3) * w0.y)) / w0.y, e = floor(x);
    float s = smoothstep(w0.y - w0.z, w0.y, (x - e) * w0.y);
    float oa = step(0.5, hash21(id + vec2(e * 17.0, e * 3.0))), ob = step(0.5, hash21(id + vec2((e + 1.0) * 17.0, (e + 1.0) * 3.0)));
    // a tile that is to change lifts, turns a quarter and settles: it is home as the beat lands
    float turn = abs(oa - ob) * s;
    float th = 1.5707963 * turn * (hash21(id + 3.1) < 0.5 ? -1.0 : 1.0);
    vec2 q = fr - 0.5;
    q = vec2(cos(th) * q.x - sin(th) * q.y, sin(th) * q.x + cos(th) * q.y);
    vec2 fq = q + 0.5;
    float r = oa < 0.5 ? min(length(fq), length(fq - 1.0)) : min(length(fq - vec2(1.0, 0.0)), length(fq - vec2(0.0, 1.0)));
    float fv = -P.y * cos(TAU * w0.x * r);
    float gap = (0.66 - 0.2 * sin(3.1415927 * turn) - max(abs(q.x), abs(q.y))) * 8.0;
    return P.y > 0.0 ? min(fv, gap) : max(fv, -gap);
  }
  // w0 = radius, squareness, diamondness, rings inside each shape; w1 = swell on the beat, quarter-turns a beat,
  // two grids interleaved, rings sent out a beat; w2, w3 = two slow waves in the radius
  vec3 sa = shape(c, 0.0, w0, w1, w5);
  if (w1.z > 0.5) { vec3 sb = shape(c + 0.5, 0.5, w0, w1, w5); if (sb.x - sb.z < sa.x - sa.z) sa = sb; }
  float R = w0.x + sa.z + w2.w * cos(w2.x * u + w2.y * v + w2.z) + w3.w * cos(w3.x * u + w3.y * v + w3.z);
  if (w0.w > 0.5) return P.y * (cos(TAU * (w0.w * sa.x - w1.w * stair(sa.y, 0.3))) + 2.0 * (R - w0.x));
  return P.y * clamp((R - sa.x) * 5.0, -1.0, 1.0);
}

// A pattern as the film sees it, and as the record sees it: the same lattice K times finer (a conformal
// scaling by a whole number, so it stays seamless and its cells stay square), or part way between.
float patk(int k, float u, float v, float sway, float kmix) {
  if (kmix <= 0.0) return field(k, u, v + sway);
  if (kmix >= 1.0) return field(k, u * uRec2.x, v * uRec2.x + sway);
  return mix(field(k, u, v + sway), field(k, u * uRec2.x, v * uRec2.x + sway), kmix);
}

// One printing plate: the fraction of paper showing (1) or ink (0) at screen point p.
float plate(vec2 p, vec4 off) {
  p += off.xy;
  float rho = max(length(p), 1e-4);
  // Bubbles: a lens drifting across the picture. Inside, the same world is seen bulged like a glass ball and
  // printed in negative; where two overlap they cancel. The pattern never stops: it runs straight through.
  float bub = 1.0;
  for (int i = 0; i < 2; i++) {
    vec4 wn = uBub[i];
    if (wn.z > 0.001) {
      vec2 dd = p - wn.xy;
      float r = length(dd), ro = r / wn.z;
      if (ro < 1.0) p = wn.xy + dd * mix(1.0, asin(ro) / max(ro, 1e-4) * 0.63662, wn.w);
      bub *= clamp((r - wn.z) * uRes.y * 0.66, -1.0, 1.0);
    }
  }
  // the lens: a soft push toward the viewer round the middle of the frame
  p *= 1.0 - uStream.w * exp(-1.6 * dot(p, p));
  // the tilt: the screen as a plane falling away, with no lighting, only foreshortening
  float ty = 1.0 / max(1.0 - uStream.z * p.y, 0.05);
  p *= ty;

  // the flow
  vec2 z = cmul(uStream.xy, p);
  vec2 dz = uStream.xy;
  for (int j = 0; j < ${POLES}; j++) {
    vec4 pl = uPole[j];
    vec2 t = pl.xy - p;
    z -= pl.z * clog(t * pl.w);
    dz += pl.z * cdiv(vec2(1.0, 0.0), t);
  }
  vec2 d = p - uDbl.zw;
  vec2 di = cdiv(vec2(1.0, 0.0), d);
  z += cmul(uDbl.xy, di);
  dz -= cmul(uDbl.xy, cmul(di, di));
  z.x -= uRef.x;

  float px = 2.0 / uRes.y;
  float J = length(dz) * ty * ty * px;                 // ribbon units per pixel
  float u = z.x;
  float v = z.y;
  float uw = u;                                        // u as the waves see it
  float Ju = J;                                        // u per pixel, for hard edges
  float B = uRec.x, kmix = 0.0;

  // The record: the whole song on one disc, its start at the rim and its end at the label. It is the film's
  // own tunnel seen from outside: time runs down the radius on the same logarithm, only squeezed until all
  // of it fits. Rising out to it, the camera first settles into a plain tunnel (the page does that), then
  // every cell divides (the lattice turns K times finer, as if the tunnel's wall fell away), then the
  // song's bands crowd in across it.
  float Jw = J;
  if (B > 0.0) {
    float ur = uRec.y + uRec.z * log(uRec2.y / rho);
    float Bl = smoothstep(0.52, 1.0, B);
    kmix = smoothstep(0.3, 0.62, B);
    u = mix(u, ur, Bl);
    Ju = mix(J, uRec.z / rho * px, Bl);
    Jw = J * mix(1.0, uRec2.x, kmix);
  }
  u += off.z;
  uw += off.z;
  v += (off.w + uBeat.y) * uw;                         // the twist: the harmony leans the lattice

  // what is painted here
  float x = clamp(uRib.x + u * uRib.y, 0.0, uRib.z);
  float xi = floor(x);
  vec4 rb = mix(texelFetch(uRibbon, ivec2(int(xi), 0), 0),
                texelFetch(uRibbon, ivec2(int(min(xi + 1.0, uRib.z)), 0), 0), x - xi);
  int ia = int(floor(rb.x));
  float m = rb.x - float(ia);
  ia = clamp(ia, 0, ${MAXP - 1});
  int ib = min(ia + 1, ${MAXP - 1});

  float f = patk(ia, uw, v, rb.z, kmix);
  vec4 qa = uPat2[ia];
  if (m > 0.002) {
    f = mix(f, patk(ib, uw, v, rb.z, kmix), m);
    qa = mix(qa, uPat2[ib], m);
  }
  float duty = rb.y + uRef.z;
  f -= qa.w + duty;

  // counterchange: black and white swap sides across a hard edge that travels with the ribbon
  float pol = bub * clamp(rb.w / max(Ju * 0.75, 1e-6), -1.0, 1.0);
  // on the record, everything already played is printed in negative: the edge is the needle
  if (B > 0.0) pol *= clamp((u + uRec2.w) / max(Ju * 0.75, 1e-6), -1.0, 1.0);
  f *= pol;

  // only the field near its edge matters for drawing the edge: flatten the rest, so a tile that has turned
  // against its neighbours shows no seam
  float g = clamp(f * 4.0, -1.0, 1.0);
  float aa = clamp(g / max(fwidth(g), 1e-6) * 0.75 + 0.5, 0.0, 1.0);
  // too fine to draw: show the even grey that fine lines really make, never sparkle
  float res = 1.0 - smoothstep(1.1, 2.4, qa.z * Jw);
  float mean = clamp(qa.x - qa.y * duty, 0.0, 1.0);
  mean = mix(mean, 1.0 - mean, step(pol, 0.0));
  float cov = mix(mean, aa, res);
  // rising to the record, what is too fine to draw becomes the label: solid ink with a hard edge, growing
  // out of the vanishing point
  if (kmix > 0.0) cov *= 1.0 - clamp((qa.z * Jw - 2.0 - 7.0 * (1.0 - kmix)) * 5.0, 0.0, 1.0);
  if (B > 0.0) {
    // the pattern stops where the song does: bare paper beyond its first second, the label after its last
    cov = mix(cov, 1.0, clamp((uRec.y - uRec2.w - u) / Ju + 0.5, 0.0, 1.0));
    cov = mix(cov, 0.0, clamp((u - uRec2.z - uRec2.w) / Ju + 0.5, 0.0, 1.0));
  }
  return cov;
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / (0.5 * uRes.y);
  vec3 col;
  if (uMode.x < 0.001) {
    col = vec3(plate(p, vec4(0.0)));
  } else {
    float c0 = plate(p, uPlate[0]);
    float c1 = plate(p, uPlate[1]);
    float c2 = plate(p, uPlate[2]);
    col = uPaper * mix(uInk[0], vec3(1.0), c0) * mix(uInk[1], vec3(1.0), c1) * mix(uInk[2], vec3(1.0), c2);
  }
  outColor = vec4(col, 1.0);
}`;
