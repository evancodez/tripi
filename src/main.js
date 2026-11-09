// tripi: drop in a song, and the page plays a film made for it.
import { createRenderer } from './gl/renderer.js';
import { V } from './film/view.js';
import { filmAt } from './film/director.js';
import { idleFilm } from './film/idle.js';

const $ = id => document.getElementById(id);
const canvas = $('stage'), body = document.body;
const params = new URLSearchParams(location.search);
const clamp = (x, a, b) => x < a ? a : x > b ? b : x;

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

// ---------------------------------------------------------------- state
const frame = { view: new Float32Array(V.N), ucam: 0, spin: 0, colour: 0, inks: PALETTES[0], paper: PAPER, rec: null };
const idle = idleFilm();
let film = idle;               // the film on screen
let song = null;               // { name, buffer, film, info }
let playing = false;
let offset = 0;                // song position when playback last started or stopped
let startedAt = 0;             // AudioContext time the source started
let source = null, ctx = null, gain = null;
let clock = 0;                 // smoothed song position
let held = null;               // lab: a fixed time to draw
let colourOn = params.get('colour') === '1', colour = colourOn ? 1 : 0;
let idleT0 = performance.now();
let take = +(params.get('take') || 1);
const muted = params.get('mute') === '1';

R.setRibbon(film.ribbon);

function resize() {
  const dpr = window.devicePixelRatio || 1;
  R.resize(Math.max(2, Math.round(innerWidth * dpr)), Math.max(2, Math.round(innerHeight * dpr)));
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
  if (!song) return;
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
  wake();
}
function stopSource() {
  if (source) { try { source.onended = null; source.stop(); } catch {} source.disconnect(); source = null; }
}
function pause() {
  if (!playing) return;
  offset = clamp(clock, 0, song.buffer.duration);
  stopSource();
  playing = false;
  wake();
}
function seek(t) {
  if (!song) return;
  t = clamp(t, 0, song.buffer.duration - 0.05);
  if (playing) play(t); else { offset = t; clock = t; }
}
function ended() {
  stopSource();
  playing = false;
  offset = song.buffer.duration;
  body.classList.remove('playing');
  say('space to play it again');
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

const say = text => { $('say').textContent = text; };
let loading = false;

async function load(name, getData) {
  if (loading) return;
  loading = true;
  body.classList.add('busy');
  try {
    if (playing) pause();
    body.classList.remove('playing', 'loaded');
    say('opening ' + name);
    const data = await getData();
    const c = audio();
    const buffer = await c.decodeAudioData(data);
    say('listening');
    const n = buffer.length, pcm = new Float32Array(n);
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) { const d = buffer.getChannelData(ch); for (let i = 0; i < n; i++) pcm[i] += d[i]; }
    if (buffer.numberOfChannels > 1) for (let i = 0; i < n; i++) pcm[i] /= buffer.numberOfChannels;
    const m = await direct({ type: 'song', pcm, sampleRate: buffer.sampleRate, seed: take }, p => say('listening ' + Math.round(p * 100) + '%'));
    song = { name, buffer, film: m.film, info: m.info };
    film = song.film;
    R.setRibbon(film.ribbon);
    R.warm();
    offset = +(params.get('t') || 0); clock = offset;
    body.classList.add('loaded');
    say(name);
    if (c.state === 'running' || params.get('autoplay') === '1') play(offset);
    else say('space to play');
  } catch (err) {
    console.error(err);
    say('could not read that as a song');
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
    song.film = m.film; film = m.film;
    R.setRibbon(film.ribbon);
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
function note(text) { const n = $('note'); n.textContent = text; n.classList.add('on'); clearTimeout(noteTimer); noteTimer = setTimeout(() => n.classList.remove('on'), 1400); wake(); }

let quietTimer = 0;
function wake() {
  $('ui').classList.add('show');
  body.classList.remove('quiet');
  clearTimeout(quietTimer);
  quietTimer = setTimeout(() => { if (playing) { body.classList.add('quiet'); $('ui').classList.remove('show'); } }, 2200);
}
addEventListener('pointermove', wake);
addEventListener('pointerdown', wake);

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
  else if (k === 'escape') { if (song) { pause(); body.classList.remove('playing'); say(song.name); } }
});
$('bar').addEventListener('pointerdown', e => { if (song) seek(e.clientX / innerWidth * song.buffer.duration); });

// ---------------------------------------------------------------- the frame
const NSTAT = 8192;
const stat = { dt: new Float32Array(NSTAT), cpu: new Float32Array(NSTAT), n: 0, on: false };
let lastNow = 0;

function tick(now) {
  requestAnimationFrame(tick);
  const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 1 / 60;
  const c0 = performance.now();
  let t;
  if (held !== null) t = held;
  else if (film === idle) t = ((now - idleT0) / 1000) % (idle.duration - 1);
  else if (playing) {
    // a clock that runs on frame time and is steered gently onto the audio's own
    clock += dt;
    const err = songTime() - clock;
    if (Math.abs(err) > 0.08) clock += err; else clock += err * 0.06;
    t = clock;
    if (t >= song.buffer.duration) { ended(); t = song.buffer.duration; }
  } else t = clock;

  filmAt(film, Math.max(0, t), frame);
  frame.inks = PALETTES[film.palette || 0];
  colour += clamp((colourOn ? 1 : 0) - colour, -dt / 2.2, dt / 2.2);
  frame.colour = colour * colour * (3 - 2 * colour);
  R.draw(frame);
  if (song && film !== idle) $('fill').style.width = (clamp(t / song.buffer.duration, 0, 1) * 100).toFixed(2) + '%';

  if (stat.on && lastNow) { const i = stat.n++ % NSTAT; stat.dt[i] = now - lastNow; stat.cpu[i] = performance.now() - c0; }
  lastNow = now;
}
R.warm();
requestAnimationFrame(tick);
wake();

// ---------------------------------------------------------------- for the lab and the curious
window.tripi = {
  ready: true,
  get song() { return song && { name: song.name, duration: song.buffer.duration, info: song.info, scenes: song.film.scenes }; },
  get time() { return clock; },
  get film() { return film; },
  frameAt(t) { filmAt(film, t, frame); return { view: Array.from(frame.view), ucam: frame.ucam, spin: frame.spin }; },
  get playing() { return playing; },
  get loading() { return loading; },
  loadUrl, play, pause, seek,
  colour(on) { colourOn = !!on; colour = on ? 1 : 0; },
  hold(t) { held = t; },                     // draw the film at a fixed time (null to let go)
  // draw the film at t at once and hand back the pixels: for measuring flicker and jolts
  grab(t, colourAmt = 0) {
    filmAt(film, t, frame); frame.colour = colourAmt; R.draw(frame);
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
