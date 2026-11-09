# tripi

Drop in a song and the page plays a film made for it: black-and-white op-art that the camera travels
through, morphing from one pattern to the next in time with the song.

It listens to the whole song first (beats, bars, sections, the tune, the tone, the chords), directs the
whole film from that, and only then plays. Playing is a table lookup and one draw call a frame, so
nothing is built while the music runs.

## Run it

```bash
node tools/serve.mjs
```

Then open http://localhost:5400/ and drop a song on the page (mp3, m4a, wav, flac, ogg).

No install step and no dependencies; it needs Node 18 or later and a browser with WebGL2.

To pick songs from a list instead of dropping them, point the server at a folder of yours:

```bash
node tools/serve.mjs --media ~/Music/some-folder
```

Songs are never copied into this project, and `.gitignore` keeps audio out of git.

## Keys

| Key | |
| --- | --- |
| `space` | play / pause |
| `c` | colour: three ink plates slip out of register |
| `n` | a new take: a different film for the same song |
| `←` `→` | back / forward ten seconds |
| `f` | full screen |
| `h` | hide everything but the film |
| `esc` | back to the song list |

The thin line along the bottom is where you are in the song; click it to jump.

## How it works

**One idea.** The whole song is painted along one endless strip of pattern, the *ribbon*, and the film
is a camera travelling down it. A pattern is a few interfering waves; the picture is black where
their sum is negative and white where it is positive. One pattern morphs into the next where two
stretches of ribbon meet, so a change is a place you travel through, and you can see it coming.

**One shader.** The camera looks at the ribbon through a conformal map built like a 2D potential
flow: a uniform stream is the ribbon lying flat, a point source is the ribbon rolled into a tunnel,
a source and a sink make a dipole, three sources a flower. Any two views blend into each other and
stay seamless, and squares stay square however the ribbon is bent. It is all in
[src/gl/shader.js](src/gl/shader.js) and [src/film/view.js](src/film/view.js).

**What the song does.**

| In the song | On screen |
| --- | --- |
| Sections and phrases | Which pattern is painted where on the ribbon; the camera's moves land on them |
| Strong beats (1 and 3) | The flow strides forward, the picture pushes toward you, the ink swells |
| Tempo | The flow is locked to it: a whole number of pattern periods passes on every strong beat |
| The tune | Drawn into the ribbon as sway; the picture tips up and down with it |
| Tone (bright or dark) | Ink weight: bright sound thins the lines, dark sound fills them |
| Chords | The twist of the lattice |
| Big arrivals | The flow winds up and holds back, then rushes; black and white swap sides across an edge |
| Loudness | Speed, and in colour how far the plates slip apart |

| File | What it does |
| --- | --- |
| [src/audio/analyze.js](src/audio/analyze.js) | The listener: beats, bars, sections, tune, tone, chords |
| [src/film/director.js](src/film/director.js) | The director: flow, ribbon, camera, baked into tables |
| [src/film/patterns.js](src/film/patterns.js) | The pattern library |
| [src/film/ribbon.js](src/film/ribbon.js) | Paints the ribbon texture |
| [src/gl/renderer.js](src/gl/renderer.js) | One program, one draw call |
| [src/main.js](src/main.js) | The page: loading, playback, keys |

## Checking it

These drive the real page in a muted headless Chrome (start the server with `--media` first).

```bash
node tools/lab.mjs tools/watch.mjs --size 240,150 --song disclosure
```

draws a whole film frame by frame and reports flashes, flicker and jolts.

```bash
node tools/lab.mjs tools/play.mjs --size 3024,1964 --song disclosure --secs 40
```

plays a song for real and times every frame.

`tools/listen.mjs` and `tools/direct.mjs` run the listener and the director in Node on a WAV file and
print what they heard and the shot list.
