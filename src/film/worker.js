// Listening and directing happen here, off the main thread, before the film starts.
import { analyze } from '../audio/analyze.js';
import { compose } from './director.js';

let last = null;   // the last analysis, so a new take of the same song is instant

self.onmessage = e => {
  const m = e.data;
  try {
    if (m.type === 'song') {
      last = analyze(m.pcm, m.sampleRate, p => self.postMessage({ type: 'progress', id: m.id, p }));
    }
    if (!last) throw new Error('no song');
    const film = compose(last, { seed: m.seed, aspect: m.aspect });
    const info = { bpm: last.bpm, meter: last.meter, key: last.key, sections: last.sections.length, drive: film.drive };
    self.postMessage({ type: 'film', id: m.id, film, info }, [film.view.buffer, film.ucam.buffer, film.spin.buffer, film.beat.buffer, film.ribbon.data.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) });
  }
};
