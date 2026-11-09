// tripi: drop in a song, and the page plays a film made for it.
//
// A song, once heard, is a record: the whole film laid out on one disc, its first second at the rim and
// its last at the label. Playing dives into the groove; pausing, or the song ending, rises back out to
// the whole record. Click a groove to dive in there.
import { createRenderer } from './gl/renderer.js';
import { V, FAR } from './film/view.js';
import { filmAt } from './film/director.js';
import { idleFilm } from './film/idle.js';

const $ = id => document.getElementById(id);
const canvas = $('stage'), body = document.body;
const params = new URLSearchParams(location.search);
const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
const ease = x => x * x * (3 - 2 * x);
const mmss = t => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');

let R;
try { R = createRenderer(canvas); }
catch (err) { $('say').textContent = err.message; throw err; }

// Colour is three printing plates, each a different ink, on warm paper. In register they print black on
// white; the film slips them apart. Each set of three multiplies to near black. A song gets one set.
const PALETTES = [
  [[1, 0.2, 0.62], [0, 0.42, 0.78], [1, 0.88, 0]],        // riso: fluorescent pink, blue, yellow
  [[0, 0.66, 0.93], [0.94, 0.05, 0.52], [1, 0.92, 0]],    // process: cyan, magenta, yellow
  [[1, 0.4, 0.05], [0.4, 0.22, 0.95], [0, 0.78, 0.62]],   // dusk: orange, violet, teal
  [[0.78, 1, 0], [1, 0.1, 0.58], [0.1, 0.22, 1]],         // acid: lime, hot pink, ultramarine
];
const PAPER = [1, 0.985, 0.955];

// the record on screen, in units of half the screen's height
const ROUT = 0.92, RIN = 0.2;
const RISE = 3.8, DIVE = 2.8;      // seconds to rise out to the record, and to dive back in

// ---------------------------------------------------------------- state
const rec = { B: 0, start: 0, end: 1, rout: ROUT, rin: RIN, k: 8 };
const frame = { view: new Float32Array(V.N), ucam: 0, spin: 0, colour: 0, inks: PALETTES[0], paper: PAPER, rec };
const idle = idleFilm();
let film = null;               // the film on screen
let song = null;               // { name, buffer, film, info }
let playing = false;
let offset = 0;                // song position when playback last started or stopped
let startedAt = 0;             // AudioContext time the source started
let source = null, ctx = null, gain = null;
let clock = 0;                 // smoothed song position
let idleClock = 0;
let held = null;               // lab: a fixed time to draw
let colourOn = params.get('colour') === '1', colour = colourOn ? 1 : 0;
let take = +(params.get('take') || 1);
let recLin = 1;                // 1 = the whole record, 0 = inside the film
let press = 1;                 // 1 = the record pressed out to its rim, 0 = drawn back into the label
let pressWant = 1;
let turn = 0;                  // the record turns slowly while you look at it
let scale = 1;                 // shrinks the record on a narrow window
const muted = params.get('mute') === '1';

function setFilm(f) {
  film = f;
  R.setRibbon(f.ribbon);
  rec.start = f.ucam[0];
  rec.end = f.ucam[f.frames - 1];
  // on the record the lattice is K times finer than in the film: about 160 cells round the disc
  rec.k = Math.max(2, Math.round(160 / f.n0));
}
setFilm(idle);

function resize() {
  const dpr = window.devicePixelRatio || 1;
  R.resize(Math.max(2, Math.round(innerWidth * dpr)), Math.max(2, Math.round(innerHeight * dpr)));
  scale = Math.min(1, innerWidth / innerHeight * 0.98);
  const d = Math.round(RIN * scale * innerHeight * 0.82);
  $('label').style.width = d + 'px';
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- audio
function audio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
    gain = ctx.createGain();
    gain.gain.value = muted ? 0 : 1;
    gain.connect(ctx.destination);
  }
  return ctx;
}

function songTime() {
  if (!playing || !ctx) return offset;
  const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
  if (ts && ts.performanceTime > 0) return offset + (ts.contextTime - startedAt) + (performance.now() - ts.performanceTime) / 1000;
  return offset + (ctx.currentTime - startedAt) - (ctx.outputLatency || 0);
}

function play(from = offset) {
  if (!song || loading) return;
  const c = audio();
  if (c.state === 'suspended') c.resume();
  stopSource();
  if (from >= song.buffer.duration - 0.05) from = 0;
  source = c.createBufferSource();
  source.buffer = song.buffer;
  source.connect(gain);
  offset = from;
  startedAt = c.currentTime + 0.05;
  source.start(startedAt, from);
  clock = from;
  playing = true;
  body.classList.add('playing');
  body.classList.remove('list');
}
function stopSource() {
  if (source) { try { source.stop(); } catch {} source.disconnect(); source = null; }
}
function pause() {
  if (!playing) return;
  offset = clamp(clock, 0, song.buffer.duration);
  stopSource();
  playing = false;
  body.classList.remove('playing');
  label();
}
function seek(t) {
  if (!song) return;
  t = clamp(t, 0, song.buffer.duration - 0.05);
  if (playing) play(t); else { offset = t; clock = t; label(); }
}
function ended() {
  stopSource();
  playing = false;
  offset = clock = song.buffer.duration;
  body.classList.remove('playing');
  label();
}

// ---------------------------------------------------------------- loading a song
const worker = new Worker(new URL('./film/worker.js', import.meta.url), { type: 'module' });
let jobId = 0;
const jobs = new Map();
worker.onmessage = e => {
  const m = e.data, job = jobs.get(m.id);
  if (!job) return;
  if (m.type === 'progress') job.progress(m.p);
  else { jobs.delete(m.id); m.type === 'film' ? job.resolve(m) : job.reject(new Error(m.message)); }
};
function direct(msg, progress = () => {}) {
  return new Promise((resolve, reject) => { const id = ++jobId; jobs.set(id, { resolve, reject, progress }); worker.postMessage({ ...msg, id, aspect: innerWidth / innerHeight }, msg.pcm ? [msg.pcm.buffer] : []); });
}

// what the label at the middle of the record says
let hoverT = null;
function label(text) {
  if (text !== undefined) { $('title').textContent = text; $('time').textContent = ''; return; }
  if (!song) { $('title').textContent = ''; $('time').textContent = ''; return; }
  $('title').textContent = song.name;
  const d = song.buffer.duration;
  $('time').textContent = hoverT !== null ? mmss(hoverT) : clock > 0.5 && clock < d - 0.1 ? mmss(clock) + ' / ' + mmss(d) : mmss(d);
}
const say = text => { $('say').textContent = text; if (!body.classList.contains('list')) label(text); };
let loading = false;
const wait = ms => new Promise(r => setTimeout(r, ms));

async function load(name, getData) {
  if (loading) return;
  loading = true;
  body.classList.add('busy');
  try {
    if (playing) pause();
    body.classList.remove('list');
    body.classList.add('loaded');
    pressWant = 0;                       // the record on the table draws back into its label
    say('opening');
    const data = await getData();
    const c = audio();
    const buffer = await c.decodeAudioData(data);
    say('listening');
    const n = buffer.length, pcm = new Float32Array(n);
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) { const d = buffer.getChannelData(ch); for (let i = 0; i < n; i++) pcm[i] += d[i]; }
    if (buffer.numberOfChannels > 1) for (let i = 0; i < n; i++) pcm[i] /= buffer.numberOfChannels;
    const m = await direct({ type: 'song', pcm, sampleRate: buffer.sampleRate, seed: take }, p => say('listening ' + Math.round(p * 100) + '%'));
    while (press > 0.01) await wait(30);
    song = { name, buffer, film: m.film, info: m.info };
    setFilm(song.film);
    R.warm();
    offset = clock = +(params.get('t') || 0);
    recLin = 1;
    pressWant = 1;                       // and the new one is pressed
    label();
    loading = false;
    note('space, or click a groove');
    if (params.get('autoplay') !== '0' && c.state === 'running') { await wait(1900); if (!playing && song && song.film === m.film && !loading) play(offset); }
  } catch (err) {
    console.error(err);
    pressWant = 1;
    say('could not read that as a song');
    if (!song) { body.classList.remove('loaded'); body.classList.add('list'); }
  } finally {
    loading = false;
    body.classList.remove('busy');
  }
}
const loadFile = file => load(file.name.replace(/\.[^.]+$/, ''), () => file.arrayBuffer());
const loadUrl = (url, name) => load(name || decodeURIComponent(url.split('/').pop()).replace(/\.[^.]+$/, ''), async () => { const r = await fetch(url); if (!r.ok) throw new Error('fetch ' + r.status); return r.arrayBuffer(); });

async function newTake() {
  if (!song || loading) return;
  loading = true;
  try {
    take++;
    const m = await direct({ type: 'take', seed: take });
    song.film = m.film;
    setFilm(m.film);
    note('take ' + take);
  } finally { loading = false; }
}

// songs offered by the local server, if it has a folder of them
fetch('media/index.json').then(r => r.ok ? r.json() : []).then(list => {
  for (const f of list) {
    const li = document.createElement('li'), b = document.createElement('button');
    b.textContent = f.replace(/\.[^.]+$/, '');
    b.onclick = () => loadUrl('media/' + encodeURIComponent(f));
    li.appendChild(b); $('songs').appendChild(li);
  }
  const want = params.get('song');
  if (want) { const f = list.find(x => x.toLowerCase().startsWith(want.toLowerCase())); if (f) loadUrl('media/' + encodeURIComponent(f)); }
}).catch(() => {});

// ---------------------------------------------------------------- input
$('file').onchange = e => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; };
addEventListener('dragover', e => { e.preventDefault(); });
addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) loadFile(f); });

let noteTimer = 0;
function note(text) { const n = $('note'); n.textContent = text; n.classList.add('on'); clearTimeout(noteTimer); noteTimer = setTimeout(() => n.classList.remove('on'), 2600); }

// where on the record the pointer is: its radius in record units, and the song time under it
function timeAtU(f, u) {
  let lo = 0, hi = f.frames - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (f.ucam[mid] < u) lo = mid; else hi = mid; }
  const span = f.ucam[hi] - f.ucam[lo];
  return (lo + (span > 0 ? (u - f.ucam[lo]) / span : 0)) / f.fps;
}
function pointerAt(e) {
  const x = (e.clientX - innerWidth / 2) / (innerHeight / 2), y = (e.clientY - innerHeight / 2) / (innerHeight / 2);
  const rho = Math.hypot(x, y) / scale;
  let t = null;
  if (song && rho >= RIN && rho <= ROUT) t = clamp(timeAtU(film, rec.start + Math.log(ROUT / rho) / Math.log(ROUT / RIN) * (rec.end - rec.start)), 0, song.buffer.duration - 0.1);
  return { rho, t };
}
const onRecord = () => song && !playing && !loading && recLin > 0.85 && !body.classList.contains('list');
canvas.addEventListener('pointermove', e => {
  const ring = $('ring');
  if (!onRecord()) { ring.classList.remove('on'); canvas.style.cursor = ''; if (hoverT !== null) { hoverT = null; label(); } return; }
  const { rho, t } = pointerAt(e);
  hoverT = t;
  canvas.style.cursor = t !== null || rho < RIN ? 'pointer' : '';
  ring.classList.toggle('on', t !== null);
  if (t !== null) { const d = rho * scale * innerHeight; ring.style.width = ring.style.height = d + 'px'; }
  label();
});
canvas.addEventListener('pointerleave', () => { $('ring').classList.remove('on'); hoverT = null; if (song && !loading) label(); });
canvas.addEventListener('pointerdown', e => {
  if (!song || loading || body.classList.contains('list')) return;
  if (playing) { pause(); return; }
  const { rho, t } = pointerAt(e);
  $('ring').classList.remove('on'); hoverT = null;
  if (t !== null) play(t);
  else if (rho < RIN) play();
});

addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); if (song) playing ? pause() : play(); }
  else if (k === 'c') { colourOn = !colourOn; note(colourOn ? 'colour' : 'black and white'); }
  else if (k === 'h') { body.classList.toggle('hide'); }
  else if (k === 'f') { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {}); }
  else if (k === 'n') { newTake(); }
  else if (k === 'arrowright') { seek(clock + 10); }
  else if (k === 'arrowleft') { seek(clock - 10); }
  else if (k === 'escape') { if (song && !loading) { if (playing) pause(); body.classList.toggle('list'); $('say').textContent = 'drop a song anywhere'; } }
});

// ---------------------------------------------------------------- the frame
const NSTAT = 8192;
const stat = { dt: new Float32Array(NSTAT), cpu: new Float32Array(NSTAT), n: 0, on: false };
let lastNow = 0, lastLabel = -1;

// Ease a view toward a plain tunnel at the middle of the screen: the view the record is the pull-back of.
function relax(s, x) {
  const y = 1 - x;
  s[V.SMAG] *= y; s[V.TILT] *= y; s[V.LENS] *= y; s[V.DUTY] *= y; s[V.TWIST] *= y; s[V.DR] *= y;
  s[V.P1R] *= y;
  for (const o of [V.P2R, V.P3R, V.PSR]) s[o] += (FAR - s[o]) * x;
}

function draw(t, B, rout, dt) {
  filmAt(film, Math.max(0, t), frame);
  // rising: the camera settles into a plain tunnel, then the cells divide, then the bands crowd in (see the shader)
  if (B > 0) relax(frame.view, ease(clamp(B / 0.36, 0, 1)));
  rec.B = B;
  rec.rout = rout * scale; rec.rin = RIN * scale;
  turn += dt * 0.035 * rec.B;
  frame.spin += turn;
  frame.inks = PALETTES[film.palette || 0];
  frame.colour = colour * colour * (3 - 2 * colour);
  R.draw(frame);
}

function tick(now) {
  requestAnimationFrame(tick);
  const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 1 / 60;
  const c0 = performance.now();
  let t;
  if (held !== null) t = held.t;
  else if (!song) { idleClock += dt * 0.5; t = idleClock % (idle.duration - 4); }
  else if (playing) {
    // a clock that runs on frame time and is steered gently onto the audio's own
    clock += dt;
    const err = songTime() - clock;
    if (Math.abs(err) > 0.08) clock += err; else clock += err * 0.06;
    t = clock;
    if (t >= song.buffer.duration) { ended(); t = song.buffer.duration; }
  } else t = clock;

  const want = held !== null ? held.B : playing ? 0 : 1;
  recLin = held !== null ? want : recLin + clamp(want - recLin, -dt / DIVE, dt / RISE);
  press += clamp(pressWant - press, -dt / 0.7, dt / 1.3);
  colour += clamp((colourOn ? 1 : 0) - colour, -dt / 2.2, dt / 2.2);
  draw(t, recLin, RIN * Math.pow(ROUT / RIN, 0.02 + 0.98 * ease(press)), dt);

  body.classList.toggle('record', recLin > 0.8 && press > 0.5);
  if (song && !playing && !loading && hoverT === null) { const s = Math.floor(clock); if (s !== lastLabel) { lastLabel = s; label(); } }

  if (stat.on && lastNow) { const i = stat.n++ % NSTAT; stat.dt[i] = now - lastNow; stat.cpu[i] = performance.now() - c0; }
  lastNow = now;
}
R.warm();
body.classList.add('list');
requestAnimationFrame(tick);

// ---------------------------------------------------------------- for the lab and the curious
window.tripi = {
  ready: true,
  get song() { return song && { name: song.name, duration: song.buffer.duration, info: song.info, scenes: song.film.scenes }; },
  get time() { return clock; },
  get film() { return film; },
  get playing() { return playing; },
  get loading() { return loading; },
  get record() { return recLin; },
  frameAt(t) { filmAt(film, t, frame); return { view: Array.from(frame.view), ucam: frame.ucam, spin: frame.spin }; },
  loadUrl, play, pause, seek,
  colour(on) { colourOn = !!on; colour = on ? 1 : 0; },
  hold(t, B = 0) { held = t === null ? null : { t, B }; },      // draw the film at a fixed time (null to let go)
  // draw the film at t at once and hand back the pixels: for measuring flicker and jolts
  grab(t, colourAmt = 0, B = 0) {
    const c = colour; colour = colourAmt;
    draw(t, B, ROUT, 0);
    colour = c;
    const gl = R.gl, px = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  },
  statsStart() { stat.n = 0; stat.on = true; },
  stats() {
    stat.on = false;
    const n = Math.min(stat.n, NSTAT), d = Array.from(stat.dt.subarray(0, n)).sort((a, b) => a - b), c = Array.from(stat.cpu.subarray(0, n)).sort((a, b) => a - b);
    const q = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))] || 0;
    const med = q(d, 0.5);
    return { frames: n, median: med, p95: q(d, 0.95), p99: q(d, 0.99), max: d[n - 1] || 0, late: d.filter(x => x > med * 1.5).length, cpuMedian: q(c, 0.5), cpuMax: c[n - 1] || 0, size: [canvas.width, canvas.height] };
  },
};
