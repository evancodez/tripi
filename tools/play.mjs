// Play a song for real (muted) and time every frame: is playback smooth?
//
//   node tools/lab.mjs tools/play.mjs --size 3024,1964 --song disclosure [--from 20] [--secs 40] [--colour] [--record]
//
// --record pauses and resumes every few seconds, so the rise to the record and the dive back in are timed too.
export default async ({ page, args, log, sleep }) => {
  const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
  const song = opt('song', 'disclosure'), secs = +opt('secs', 40), from = +opt('from', 0);
  await page.waitFor('window.tripi && window.tripi.ready');
  await page.eval(s => { tripi.loadUrl('media/' + s + '.mp3'); }, song);
  await page.waitFor('window.tripi.song && !window.tripi.loading', 180000);
  if (args.includes('--colour')) await page.eval(() => tripi.colour(true));
  await page.eval(t => { tripi.play(t); }, from);
  await sleep(3500);
  const t0 = await page.eval(() => { tripi.statsStart(); return tripi.time; });
  if (args.includes('--record')) {
    for (let s = 0; s < secs; s += 8) { await sleep(2000); await page.eval(() => tripi.pause()); await sleep(4200); await page.eval(() => tripi.play()); await sleep(1800); }
  } else await sleep(secs * 1000);
  const r = await page.eval(() => ({ ...tripi.stats(), time: tripi.time, playing: tripi.playing }));
  const fps = 1000 / r.median;
  log(`${song}${args.includes('--colour') ? ' colour' : ''}${args.includes('--record') ? ' with rises and dives' : ''}  ${r.size.join('x')}  ${r.frames} frames in ${secs} s  (song clock moved ${(r.time - t0).toFixed(2)} s)`);
  log(`  frame time: median ${r.median.toFixed(2)} ms (${fps.toFixed(1)} fps)  p95 ${r.p95.toFixed(2)}  p99 ${r.p99.toFixed(2)}  max ${r.max.toFixed(2)}  late frames (>1.5x median): ${r.late}`);
  log(`  main-thread work per frame: median ${r.cpuMedian.toFixed(3)} ms  max ${r.cpuMax.toFixed(2)} ms   page problems: ${page.problems()}`);
};
