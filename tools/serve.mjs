// A tiny static server for tripi. No dependencies.
//
//   node tools/serve.mjs [--port 5400] [--media <folder of songs>]
//
// Songs are never part of the repo. If a folder of songs is given (or ./media exists), it is
// listed at /media/index.json and served from /media/<file>, so the page can offer them to pick.
import { createServer } from 'node:http';
import { createReadStream, existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { extname, join, resolve, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = (name, d) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : d; };
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = +(opt('port', process.env.PORT || 5400));
const mediaArg = opt('media', process.env.TRIPI_MEDIA || join(root, 'media'));
const media = existsSync(mediaArg) ? realpathSync(mediaArg) : null;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.ogg': 'audio/ogg', '.aac': 'audio/aac', '.opus': 'audio/ogg',
};
const AUDIO = new Set(['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac', '.opus']);

const inside = (base, p) => p === base || p.startsWith(base + sep);

function send(res, file) {
  let st;
  try { st = statSync(file); } catch { res.writeHead(404).end('not found'); return; }
  if (st.isDirectory()) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-store',
  });
  createReadStream(file).pipe(res);
}

createServer((req, res) => {
  let path;
  try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  if (path === '/media/index.json') {
    let list = [];
    if (media) {
      try { list = readdirSync(media).filter(f => AUDIO.has(extname(f).toLowerCase())).sort(); } catch {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(list));
    return;
  }
  if (path.startsWith('/media/')) {
    if (!media) { res.writeHead(404).end('no media'); return; }
    const file = normalize(join(media, path.slice(7)));
    if (!inside(media, file)) { res.writeHead(403).end(); return; }
    // songs in the folder may be symlinks to wherever the owner keeps them
    try { send(res, realpathSync(file)); } catch { res.writeHead(404).end('not found'); }
    return;
  }
  if (path === '/') path = '/index.html';
  const file = normalize(join(root, path));
  if (!inside(root, file) || path.includes('/.git')) { res.writeHead(403).end(); return; }
  send(res, file);
}).listen(port, '127.0.0.1', () => {
  console.log(`tripi  http://localhost:${port}/` + (media ? `   songs: ${media}` : '   (no songs folder; drop a song on the page)'));
});
