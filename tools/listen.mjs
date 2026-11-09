// Run the listener on a WAV file (16-bit PCM) and print what it heard. For checking the analysis in Node.
//   node tools/listen.mjs song.wav [--json out.json]
// (macOS: afconvert -f WAVE -d LEI16@44100 -c 1 song.mp3 song.wav)
import { readFileSync, writeFileSync } from 'node:fs';
import { analyze } from '../src/audio/analyze.js';

export function readWav(file) {
  const b = readFileSync(file);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(off + 10), sr: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === 'data') { data = b.subarray(off + 8, off + 8 + size); break; }
    off += 8 + size + (size & 1);
  }
  if (!fmt || !data || fmt.bits !== 16) throw new Error('need 16-bit PCM WAV');
  const n = Math.floor(data.length / 2 / fmt.ch), pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < fmt.ch; c++) s += data.readInt16LE((i * fmt.ch + c) * 2); pcm[i] = s / fmt.ch / 32768; }
  return { pcm, sr: fmt.sr };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  const { pcm, sr } = readWav(file);
  const t0 = performance.now();
  const a = analyze(pcm, sr);
  const ms = performance.now() - t0;
  const mmss = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  console.log(`${file}\n  ${a.duration.toFixed(1)} s, ${a.bpm.toFixed(1)} bpm, ${a.meter}/4, ${a.beats.length} beats, ${a.bars.length} bars, key ${'C C# D D# E F F# G G# A A# B'.split(' ')[a.key.tonic]}${a.key.minor ? 'm' : ''}, analysed in ${ms.toFixed(0)} ms`);
  for (const s of a.sections) console.log(`  ${mmss(s.t0).padStart(7)}  ${String(s.bar1 - s.bar0).padStart(3)} bars  ${String.fromCharCode(65 + s.label)}  energy ${s.energy.toFixed(2)}  lift ${s.lift >= 0 ? '+' : ''}${s.lift.toFixed(2)} near ${(s.near??9).toFixed(2)} nov ${s.nov.toFixed(2)}  ${'#'.repeat(Math.round(s.energy * 30))}`);
  const j = process.argv.indexOf('--json');
  if (j > 0) writeFileSync(process.argv[j + 1], JSON.stringify(a, (k, v) => ArrayBuffer.isView(v) ? Array.from(v, x => +x.toFixed(4)) : v));
}
