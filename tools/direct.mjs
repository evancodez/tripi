// Listen to a WAV and print the film the director makes for it: the shot list, in Node.
//   node tools/direct.mjs song.wav [seed]
import { readWav } from './listen.mjs';
import { analyze } from '../src/audio/analyze.js';
import { compose } from '../src/film/director.js';

const { pcm, sr } = readWav(process.argv[2]);
const a = analyze(pcm, sr);
const t0 = performance.now();
const film = compose(a, { seed: +(process.argv[3] || 1) });
const mmss = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
console.log(`${a.bpm.toFixed(1)} bpm ${a.meter}/4  drive ${film.drive.toFixed(2)}  n0 ${film.n0}  ${film.scenes.length} scenes  ribbon ${film.ucam[film.frames - 1].toFixed(1)} long  sink never nearer a source than ${film.closest.toFixed(2)}  composed in ${(performance.now() - t0).toFixed(0)} ms`);
for (const s of film.scenes) console.log(`  ${mmss(s.t0).padStart(7)} ${(s.t1 - s.t0).toFixed(1).padStart(5)}s  e ${s.energy.toFixed(2)}  ${(s.pattern + ' ' + s.n).padEnd(13)} ${s.kind.padEnd(10)} v ${s.speed.toFixed(2)} ${s.big ? ' BIG' : ''}${s.rings ? ' rings' : ''}`);
let bad = 0; for (const x of film.view) if (!Number.isFinite(x)) bad++;
if (bad) console.log('  NON-FINITE values in the view table:', bad);
