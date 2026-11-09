// The lab: runs the real page in a real, GPU-backed, muted headless Chrome and lets a script look at it.
//
//   node tools/lab.mjs <script.mjs> [--size 1280,720] [--url http://localhost:5400/] [--out <dir>] [--headed]
//
// The script's default export receives { page, save, sleep, out, log, args }:
//   page.eval(fnOrExpr, ...args)   evaluate in the page (async is fine), returns the JSON result
//   page.shot(name)                screenshot of the page to <out>/<name>.png
// It never plays sound: Chrome is started with --mute-audio.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';

const argv = process.argv.slice(2);
const opt = (name, d) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : d; };
const flag = name => argv.includes('--' + name);
const script = argv[0];
if (!script) { console.error('usage: node tools/lab.mjs <script.mjs> [--size W,H] [--url URL] [--out DIR] [--headed]'); process.exit(2); }

const chrome = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
if (!chrome) { console.error('no Chrome found; set CHROME=/path/to/chrome'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const out = resolve(opt('out', join(tmpdir(), 'tripi-lab-out')));
mkdirSync(out, { recursive: true });
const [w, h] = opt('size', '1280,720').split(',').map(Number);
const url = opt('url', process.env.LAB_URL || 'http://localhost:5400/');
const port = await freePort();
const profile = mkdtempSync(join(tmpdir(), `tripi-lab-${process.pid}-`));
const proc = spawn(chrome, [
  ...(flag('headed') ? [] : ['--headless=new']),
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${w},${h}`,
  '--mute-audio', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  ...(flag('vsync-off') ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []),
  'about:blank',
], { stdio: 'ignore' });

let done = false;
const finish = code => { if (done) return; done = true; try { proc.kill('SIGKILL'); } catch {} sleep(150).then(() => { try { rmSync(profile, { recursive: true, force: true }); } catch {} process.exit(code); }); };
process.on('SIGINT', () => finish(130));
process.on('SIGTERM', () => finish(143));

for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(150); } }
const created = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(created.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0;
const pending = new Map(), listeners = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method) for (const l of listeners) l(m);
};
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

const logs = [];
let problems = 0;
listeners.push(m => {
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = m.params.args.map(a => a.value ?? a.description ?? '').join(' ');
    logs.push(`[${m.params.type}] ${text}`);
    if (m.params.type === 'error' || m.params.type === 'warning') { problems++; console.log(`  page ${m.params.type}: ${text.slice(0, 600)}`); }
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    problems++;
    console.log('  page exception: ' + `${d.text} ${d.exception?.description || ''}`.slice(0, 900));
  }
  if (m.method === 'Inspector.targetCrashed') { console.log('lab: the page crashed'); finish(3); }
});
await send('Runtime.enable');
await send('Page.enable');
await send('Inspector.enable');
await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });

const save = (name, data) => {
  const file = join(out, name);
  if (typeof data === 'string' && data.startsWith('data:')) writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
  else writeFileSync(file, data);
  return file;
};
const page = {
  async eval(fn, ...args) {
    const expression = typeof fn === 'function' ? `(${fn})(...${JSON.stringify(args)})` : fn;
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 3600000 });
    if (r.result?.exceptionDetails) throw new Error('page: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
    return r.result?.result?.value;
  },
  async shot(name, clip) {
    const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
    return save(name.endsWith('.png') ? name : name + '.png', Buffer.from(r.result.data, 'base64'));
  },
  async goto(u) { await send('Page.navigate', { url: u }); await sleep(300); },
  async waitFor(expr, ms = 60000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await page.eval(expr)) return true; await sleep(100); }
    throw new Error('timed out waiting for ' + expr);
  },
  send, logs, problems: () => problems,
};

try {
  await page.goto(url);
  const mod = await import(pathToFileURL(resolve(script)).href);
  await mod.default({ page, save, sleep, out, log: console.log, args: argv });
  finish(0);
} catch (e) {
  console.error('lab failed:', e.message);
  finish(1);
}
