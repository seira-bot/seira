# seira.bot runtime

The runtime animates the generated image frames of a bot on one 2D canvas.
It uses no WebGL and no 3D geometry. The rules come from `../live/CONTRACT.md` ("Runtime").

## Use

```js
import { createBot, EYES, MOUTHS, EXPRESSIONS, ACTIONS, STATES, WEATHER } from './runtime/bot.js';

const bot = await createBot(el, config, { bases, stickers, baseUrl });
bot.setConfig({ hairColor: '#C8475B' });
bot.express('happy', { ms: 2000 });
await bot.play('wave');
bot.setState('thinking');
bot.setWeather('rain');      // null stops the weather
bot.talk(0.6);               // 0..1
bot.lookAt(0.5, -0.2);       // -1..1, or null to follow the pointer
bot.on('tickle', () => {});  // 'tickle', 'click', 'poke', 'pet'
const png = bot.snapshot();
bot.destroy();
```

- `el` is a container or a `<canvas>`. In a container, the runtime adds a canvas that fills it.
- `bases` and `stickers` are manifest objects or manifest URLs. File paths in a manifest object resolve
  against `baseUrl + 'bases/'` and `baseUrl + 'stickers/'`. A data URL loads as it is.
  When you give only `baseUrl`, the runtime loads `bases/manifest.json` and `stickers/manifest.json`.
- The catalogs are arrays of `{ id, label }`. `DEFAULT_CONFIG` is exported too.
- `play(id)` returns a Promise. It resolves when the action ends, when a new action replaces it,
  or at once for an unknown id.

### More options

| Option | Effect |
|--------|--------|
| `reduced` | `true` or `false` sets reduced motion. Without it, the runtime reads `prefers-reduced-motion`. |
| `seed` | A number for the random generator. Use it for the same pictures in tests. |
| `manual` | `true` stops the animation clock. Call `bot.tick(ms)` to move the time and draw. |

Test helpers (not part of the contract): `bot.turn(deg | null)` holds the head at a yaw,
`bot.tick(ms)` moves the clock, `bot.time` gives the clock in seconds, and `bot.debug()` gives layout numbers.

## How it draws

Draw order: shadow, back effects, umbrella (behind the head), base frame with recolored hair,
face on the visor, accessories, hands, front effects, lightning flash.

- World space: the unit is the head radius `r` of each frame, and the origin is the frame `pivot`.
  Each frame is placed by its own `pivot` and `r`.
- Views: the runtime picks the nearest frame for the yaw (`front`, `yaw20`, `yaw45`, `side`, `back`)
  and mirrors it for a negative yaw. A strong pitch (`|pitch| > 0.55`) picks `up` or `down`.
  The current frame stays for 4 more degrees, and a change cross-fades in 0.11 s.
- Face: `face.js` draws the screen face on an offscreen canvas. The runtime scales it to the width of
  the `front` visor, moves it to the visor center of the current frame, squeezes it by `cos(yaw)`,
  and clips it with the visor mask.
- Hair: `recolor.js` changes the hair color by luminance inside the hair mask. It keeps one result
  for each frame and color.
- Missing frames, masks, and stickers are skipped. Missing effect stickers use vector shapes from `fx.js`.
- Effects: at most 300 live particles. Reduced motion shows no particles.

## Files

| File | Content |
|------|---------|
| `bot.js` | `createBot`, catalogs, view choice, face placement, drawing, public API |
| `face.js` | the screen face: eyes, mouths, lids, blush, tears, marks |
| `catalog.js` | eyes, mouths, expressions, faces, actions, states, weather, personality, defaults |
| `motion.js` | easing helpers, idle motion, hand poses, body motions |
| `actions.js` | the 27 timed actions |
| `fx.js` | particles, loop emitters, vector stand-ins |
| `interact.js` | pointer follow, click, tickle, poke, pet |
| `weather.js` | weather timers, loops, accessories, and props |
| `recolor.js` | hair and shell recolor |
| `assets.js` | manifest and image loading, masks |
| `demo.js` | test page |
| `tools/embed.py` | builds a test page that renders alone |

## Interaction

| Input | Result | Event |
|-------|--------|-------|
| Pointer move | The head turns and the eyes look toward the pointer. | none |
| Click on the head | A short smile and a hop. | `click` |
| 4 direction changes in 800 ms over the head | `giggle`, then `laugh` if it continues. | `tickle` |
| Press and hold 600 ms | Shy face with blush and a heart. | `poke` |
| Slow stroke down over the hair | Half-closed happy eyes. | `pet` |

## Test page

Build a page with the images in it as data URLs. The page needs no other file.

```bash
python3 brand/mascot/runtime/tools/embed.py .explore/runtime-seira.html --styles seira
python3 brand/mascot/runtime/tools/embed.py .explore/runtime-grid.html --styles seira,seira-long --scale 0.5
brand/mascot/live/tools/shot.sh .explore/runtime-grid.html .explore/runtime-shots/grid-expressions.png 1250x1500 15000 "?grid=expressions&cols=5"
```

Query keys of `demo.js`:

| Key | Values |
|-----|--------|
| `style`, `eyes`, `mouth`, `personality` | catalog ids |
| `hair`, `shell`, `eyeColor` | hex color, with or without `#` |
| `acc` | accessory ids, comma list |
| `expr`, `state`, `weather`, `action` | catalog ids |
| `yaw` | degrees |
| `p` | position in the action, 0..1 (default 0.5) |
| `t` | bot time in ms before the picture (default 1200) |
| `simulate=tickle` | rubs the pointer over the head |
| `reduced=1` | reduced motion |
| `seed` | random seed |
| `grid` | `expressions`, `actions`, `weather`, `states`, `sneeze`, `turns`, `hair`, `eyes`, `mouths`, `reduced`, `tickle` |
| `only`, `cols` | grid cell ids (comma list), grid columns |
| `live=1` | real animation clock (for a browser) |
| `debug=1` | layout numbers and the offscreen canvases |
