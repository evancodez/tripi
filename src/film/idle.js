// The film that plays before any song: the director given a slow, quiet song that doesn't exist.
import { compose } from './director.js';

export function idleFilm(seed = 7) {
  const duration = 300, bpm = 66, meter = 4, fps = 50, beatLen = 60 / bpm;
  const beats = [], bars = [], strong = [];
  for (let i = 0, t = 0; t < duration; i++, t += beatLen) { beats.push(t); if (i % 4 === 0) bars.push(t); if (i % 2 === 0) strong.push(t); }
  const n = Math.ceil(duration * fps);
  const curve = f => Float32Array.from({ length: n }, (_, i) => f(i / fps));
  const energies = [0.3, 0.5, 0.2, 0.62, 0.4, 0.74, 0.28, 0.55];
  const sections = [];
  const per = 5;                                         // bars per section: about 18 seconds
  for (let b = 0, k = 0; b < bars.length; b += per, k++) {
    const b1 = Math.min(bars.length, b + per);
    sections.push({ bar0: b, bar1: b1, t0: bars[b], t1: b1 < bars.length ? bars[b1] : duration, label: k, energy: energies[k % energies.length], lift: 0, nov: 0.5, bright: 0.5 + 0.3 * Math.sin(k * 1.7), loud: 0.5, density: 0.3 });
  }
  const a = {
    duration, bpm, meter, pulse: 0.2, busy: 0.07,
    beats: Float64Array.from(beats), bars: Float64Array.from(bars), strong: Float64Array.from(strong), sections, fps,
    loud: curve(() => 0.5), loudSlow: curve(() => 0.5),
    bright: curve(t => 0.5 + 0.3 * Math.sin(t * 0.21)),
    melody: curve(t => 0.55 * Math.sin(t * 0.9) * Math.sin(t * 0.13) + 0.25 * Math.sin(t * 2.3 + 1)),
    melConf: curve(() => 1), bass: curve(() => 0.2), onset: curve(() => 0.2),
    chords: bars.map((t, i) => ({ t, root: [0, 5, 7, 9][Math.floor(i / 2) % 4], minor: false, change: i % 2 === 0 })),
    key: { tonic: 0, minor: false },
  };
  return compose(a, { seed });
}
