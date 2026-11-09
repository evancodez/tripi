// WebGL2 renderer: one program, one triangle, one draw call a frame. Nothing is allocated or
// compiled after create(); a frame is a few hundred numbers handed to the shader.
import { VERT, FRAG, MAXP, WAVES, POLES } from './shader.js';
import { V, nowU, pole as poleOf } from '../film/view.js';

const TAU = Math.PI * 2;

export function createRenderer(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: false, antialias: false, depth: false, stencil: false,
    powerPreference: 'high-performance', preserveDrawingBuffer: false, desynchronized: true,
  });
  if (!gl) throw new Error('This browser has no WebGL2.');
  if (gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) < MAXP * (WAVES + 2) + 32) throw new Error('This GPU allows too few uniforms.');

  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(sh));
    return sh;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const U = {};
  for (const n of ['uRes', 'uRibbon', 'uRib', 'uWave', 'uPat', 'uPat2', 'uStream', 'uPole', 'uDbl', 'uRef', 'uPlate', 'uInk', 'uPaper', 'uMode', 'uRec']) {
    U[n] = gl.getUniformLocation(prog, n);
  }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(U.uRibbon, 0);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);

  // scratch, reused every frame
  const wave = new Float32Array(MAXP * WAVES * 4);
  const pat = new Float32Array(MAXP * 4);
  const pat2 = new Float32Array(MAXP * 4);
  const pole = new Float32Array(POLES * 4);
  const plate = new Float32Array(12);
  const ink = new Float32Array(9);
  let ribbon = null;

  function setRibbon(rb) {
    ribbon = rb;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, rb.W, 1, 0, gl.RGBA, gl.FLOAT, rb.data);
    for (let k = 0; k < MAXP; k++) {
      const p = rb.patterns[Math.min(k, rb.patterns.length - 1)];
      pat[k * 4] = p.c1; pat[k * 4 + 1] = p.c2; pat[k * 4 + 2] = p.lam; pat[k * 4 + 3] = p.b;
      pat2[k * 4] = p.cov0; pat2[k * 4 + 1] = p.covSlope; pat2[k * 4 + 2] = 1; pat2[k * 4 + 3] = 0;
    }
    gl.uniform4fv(U.uPat, pat);
  }

  function resize(w, h) {
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  // f: { view: Float32Array(V.N), ucam, spin, colour: 0..1, inks: [[r,g,b] x3], paper: [r,g,b], rec: [blend, uc, slope, stretch] }
  function draw(f) {
    if (!ribbon) return;
    const s = f.view;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(U.uRes, canvas.width, canvas.height);

    const twist = s[V.TWIST];
    const pats = ribbon.patterns, np = pats.length;
    for (let k = 0; k < MAXP; k++) {
      const p = pats[k < np ? k : np - 1];
      let kmax = 0;
      for (let i = 0; i < WAVES; i++) {
        const w = p.w[i], o = (k * WAVES + i) * 4;
        const a = w.a + w.n * twist;
        wave[o] = a; wave[o + 1] = w.n;
        let ph = (w.a * f.ucam + w.n * f.spin + w.ph) % TAU;
        wave[o + 2] = ph; wave[o + 3] = w.amp;
        if (w.amp !== 0) { const kk = a * a + w.n * w.n; if (kk > kmax) kmax = kk; }
      }
      pat2[k * 4 + 2] = Math.sqrt(kmax);
    }
    gl.uniform4fv(U.uWave, wave);
    gl.uniform4fv(U.uPat2, pat2);

    const sr = s[V.SMAG] * Math.cos(s[V.SROT]), si = s[V.SMAG] * Math.sin(s[V.SROT]);
    gl.uniform4f(U.uStream, sr, si, s[V.TILT], s[V.LENS]);
    for (let j = 0; j < POLES; j++) poleOf(s, j, pole, j * 4);
    gl.uniform4fv(U.uPole, pole);
    gl.uniform4f(U.uDbl, sr * s[V.DR], si * s[V.DR], s[V.EX], s[V.EY]);
    gl.uniform4f(U.uRef, nowU(s), 0, s[V.DUTY], 0);
    gl.uniform4f(U.uRib, (f.ucam - ribbon.u0) * ribbon.scale, ribbon.scale, ribbon.W - 1, 0);

    const c = f.colour || 0;
    gl.uniform4f(U.uMode, c, 0, 0, 0);
    if (c > 0) {
      const sp = s[V.SPLIT] * c, ang = s[V.PLATE];
      const inkAmt = Math.min(1, c * 3);
      for (let k = 0; k < 3; k++) {
        const th = ang + k * TAU / 3;
        // a little plain misregistration on the page, more along the ribbon, and a twist that grows away from "now"
        plate[k * 4] = 0.02 * sp * Math.cos(th);
        plate[k * 4 + 1] = 0.02 * sp * Math.sin(th);
        plate[k * 4 + 2] = 0.42 * sp * Math.cos(th * 0.5 + k * 2.1);
        plate[k * 4 + 3] = 0.09 * sp * (k - 1);
        for (let j = 0; j < 3; j++) ink[k * 3 + j] = f.inks[k][j] * inkAmt;
      }
      gl.uniform4fv(U.uPlate, plate);
      gl.uniform3fv(U.uInk, ink);
      gl.uniform3f(U.uPaper, 1 + (f.paper[0] - 1) * inkAmt, 1 + (f.paper[1] - 1) * inkAmt, 1 + (f.paper[2] - 1) * inkAmt);
    }
    const r = f.rec;
    if (r) gl.uniform4f(U.uRec, r[0], r[1], r[2], r[3]); else gl.uniform4f(U.uRec, 0, 0, 0, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Force the driver to finish building the program now, not on the first frame of a song.
  function warm() {
    gl.finish();
    const px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  }

  return { gl, canvas, setRibbon, resize, draw, warm };
}
