# seira.bot character: module contract (v2, image frames)

The character look comes from generated images (gpt-image-2.6). Code animates the images on a 2D canvas:
the face on the visor screen, body motion, hands, interaction, weather, and effects. There is no 3D geometry.
The Three.js prototype (`seira-live.js`) stays as a reference only.

This file is the shared interface. Four work streams write in parallel. Each stream changes only the folders that it owns.
If a stream needs a contract change, write it under "Change requests" at the end. Do not edit the other sections.

## Folder owners

| Folder | Owner | Contents |
|--------|-------|----------|
| `brand/mascot/art/bases/` | Bases stream | Seira frames, hair-style base frames, masks, `manifest.json`, prompts, processing tools |
| `brand/mascot/art/stickers/` | Stickers stream | hands, accessories, effect sprites, `manifest.json`, prompts, processing tools |
| `brand/mascot/runtime/` | Runtime stream | `bot.js` (2D runtime), face drawing, expressions, actions, interaction, weather, demo |
| `brand/mascot/cast/` | Cast stream | character presets (`cast.json`), cast notes, concept sheets |
| `brand/mascot/live/` | coordinator | this contract, shared tools, old 3D prototype |

## Shared rules

- English for all text: labels, code, comments, docs, and file names. The project is open source.
- No private host names, user names, keys, or absolute local paths in repo files. Machine values live in `brand/.env.local` (see `brand/.env.example`).
- Seira is the main character and the main logo. Her frames get the best quality and the most views.
- Base colors: shell `#ECEEF1`, Seira hair `#E9ECEF`, screen `#0C0F14`, Seira eyes `#FF2A57`, brand red `#E11D48`.
- No letters or words in images. Symbols (question mark, exclamation mark, Z for sleep, music note) are fine.
- Cast designs are original bots inspired by the colors and temper of each character. Do not copy costumes, emblems, or official art.

## Image generation

- Command: `"$SEIRA_IMAGE_CMD" "PROMPT" OUT.png WIDTHxHEIGHT [REFERENCE.png]` (load it with `brand/load-env.sh`).
- Model: gpt-image-2.6. The output aspect follows the prompt text, so state it ("Wide 16:9 image." or "Square image.").
- Use `brand/mascot/options/d-companion-bot.png` as the style reference, unless a better frame of the same character exists.
- Background: flat pure chroma green `#00FF00`, no floor, no shadow, no vignette. The runtime draws its own shadow.
- Keep every prompt in a `prompts.sh` next to the output and log each result (file, size, time, retries) in `gen.log`.
- At most 2 generations at the same time per stream. After a failure, wait 60 s before a retry. Keep raw outputs in `raw/`.

## Processed image format

- PNG, RGBA, sRGB, transparent background (chroma key with green despill), trimmed of stray pixels.
- Base frames: 1024 × 1024 canvas. Every frame records `pivot` (head shell center, px) and `r` (shell radius, px).
  Normalize each style so `r` is 300 ± 6 px and the front `pivot` is near (512, 452).
- Sticker frames: trimmed to content plus 8 px padding, any size up to 512 × 512.

## Bases (Bases stream, `art/bases/manifest.json`)

Views (yaw in degrees, positive = the face turns toward the viewer's right; the runtime mirrors for negative yaw):
`front` (0), `yaw20`, `yaw45`, `side` (90), `back` (180), `up` (front, head tilted back about 15°), `down` (front, head tilted forward about 15°).

```json
{
  "version": 2,
  "size": [1024, 1024],
  "styles": {
    "<style-id>": {
      "label": "Bob",
      "gender": "f",
      "recolor": true,
      "views": {
        "front": {
          "file": "out/bob/front.png",
          "hair": "out/bob/front.hair.png",
          "visor": "out/bob/front.visor.png",
          "pivot": [512, 452], "r": 300,
          "visorBox": [x, y, w, h],
          "anchors": { "top": [x, y], "earL": [x, y], "earR": [x, y], "templeL": [x, y], "templeR": [x, y],
                       "mouth": [x, y], "cheekL": [x, y], "cheekR": [x, y], "neck": [x, y] }
        }
      }
    }
  }
}
```

- `hair`: alpha mask of the hair (white = hair). `visor`: alpha mask of the screen. Both are 1024 × 1024 PNG.
- Anchors use the image pixel space. An anchor that is not visible in a view is left out.
- `recolor: true` means the hair was generated in flat magenta `#FF00FF` plastic, so the runtime can map it to any color by luminance.
- The visor screen is switched off in all base frames: plain glossy black glass with soft reflections, no eyes, no face, no glow.

Required styles:

- `seira` (Seira, `recolor: false`, native silver hair, all 7 views). This is the main logo character.
- Female, `recolor: true`: `seira-long`, `bob`, `twin-tails`, `ponytail`, `long-straight`, `bun`, `long-wavy`.
- Male, `recolor: true`: `short-neat`, `center-part`, `spiky`, `slick-back`, `long-tied`, `long-loose`, `buzz`, `messy`.
- Unisex: `none` (shell with panel lines, no hair, `recolor: false`).

Each style has all 7 views. The order of work is `seira` first, then `seira-long`, then the rest.

## Stickers (Stickers stream, `art/stickers/manifest.json`)

```json
{
  "version": 2,
  "hands":       { "<gesture>": { "file": "out/hands/open.png", "pivot": [x, y], "side": "right" } },
  "accessories": { "<id>": { "label": "Glasses", "slot": "face", "file": "out/acc/glasses.png", "pivot": [x, y],
                             "anchor": "mouth|top|earL|earR|neck|templeL|templeR", "width": 1.4, "views": ["front", "yaw20", "yaw45"] } },
  "fx":          { "<id>": { "label": "Snowflake", "frames": ["out/fx/snow-1.png"], "pivot": [x, y] } }
}
```

- Hands are right hands. The runtime mirrors them for the left hand. `pivot` is the wrist center.
- Accessory `width` is the drawn width in head radii. `views` lists the views where the accessory shows.
  An accessory with a side or back look adds `files: { "yaw45": "...", "side": "..." }`.

Required hand gestures: `open`, `wave`, `fist`, `point`, `peace`, `thumbs-up`, `ok`, `chin` (pose for a hand under the chin), `fan` (hand that fans), `hold` (cupped, holds an item), `pat`.

Required accessories: `earring` (slot `ear`), `glasses` (`face`), `sunglasses` (`face`), `headphones` (`ear`), `ribbon` (`hair`),
`hairpin` (`hair`), `tiara` (`hair`), `cap` (`top`), `antenna` (`top`), `scarf` (`neck`), `bowtie` (`neck`), `headset-mic` (`ear`).

Required fx sprites: `snowflake` (3 variants), `raindrop`, `splash`, `sweat-drop`, `frost`, `breath-puff`, `steam-puff`, `heat-wave`,
`sun-sparkle`, `lightning`, `fog-puff`, `umbrella`, `heart` (2 variants), `zzz`, `note` (2 variants), `confetti` (5 colors),
`star`, `idea-bulb`, `question`, `exclaim`, `anger-mark`, `tear`, `dizzy-star`, `tickle-sparkle`, `sneeze-cloud`, `blush`.

## Runtime (Runtime stream, `runtime/bot.js`)

```js
import { createBot, EYES, MOUTHS, EXPRESSIONS, ACTIONS, STATES, WEATHER } from './runtime/bot.js';
const bot = await createBot(el, config, { bases, stickers, baseUrl });  // manifests as objects or URLs
bot.setConfig(partial);         // change style, colors, face, or accessories
bot.express(id, { ms });        // face expression; without ms it stays until the next one
bot.play(id);                   // timed action; returns a Promise that resolves at the end
bot.setState(id);               // assistant state
bot.setWeather(id | null);      // weather reaction: face, body motion, effects
bot.talk(level);                // 0..1 mouth motion while speaking
bot.lookAt(x, y);               // -1..1, or null to follow the pointer
bot.on(event, fn);              // 'tickle', 'click', 'poke', 'pet'
bot.snapshot();                 // PNG data URL of the current frame
bot.destroy();
```

- Draw order: shadow, back effects, base frame (hair recolored), face on the visor (clipped by the visor mask,
  squeezed by `cos(yaw)` and shifted toward the turn), accessories, hands, front effects.
- Head turn: pick the two nearest yaw views and cross-fade. Mirror for negative yaw. Pitch uses `up` and `down`.
- Body motion: 2D transforms (bob, sway, squash and stretch, jitter, hop, spin through the yaw views).
- The runtime works with a partial manifest (for example, only `front` views) and skips missing stickers without an error.
- `prefers-reduced-motion`: still pose, expressions still change, no particles.

### Catalogs (required ids)

EYES: `pill`, `round`, `sharp`, `almond`, `sleepy`, `dot`, `star`, `square`.
MOUTHS: `smile`, `cat`, `flat`, `grin`, `fang`, `small-o`, `smirk`.
EXPRESSIONS: `calm`, `happy`, `laugh`, `giggle`, `love`, `shy`, `proud`, `surprised`, `confused`, `thinking`, `sad`, `cry`, `pout`,
`angry`, `sleepy`, `asleep`, `wink`, `bored`, `determined`, `dizzy`, `smug`, `scared`, `cold`, `hot`, `sick`.
ACTIONS: `wave`, `nod`, `shake-head`, `bow`, `hop`, `spin`, `dance-1`, `dance-2`, `dance-3`, `laugh`, `giggle`, `sneeze`, `hiccup`,
`yawn`, `stretch`, `think`, `idea`, `celebrate`, `oops`, `greet`, `bye`, `shiver`, `fan-self`, `wipe-sweat`, `peek`, `clap`, `facepalm`.
STATES: `idle`, `listening`, `thinking`, `talking`, `working`, `success`, `error`, `sleeping`.
WEATHER: `sunny`, `hot`, `cold`, `rain`, `storm`, `snow`, `wind`, `fog`.

### Interaction

- The head turns and the eyes glance toward the pointer.
- Click: a short smile (`click`).
- Tickle: fast back-and-forth pointer motion over the head (at least 4 direction changes within 800 ms) plays `giggle`, then `laugh` if it continues (`tickle`).
- Press and hold for 600 ms: `shy` with cheek blush (`poke`).
- Slow top-to-bottom stroke over the hair: half-closed `happy` eyes (`pet`).
- Sneeze: a build-up (`up` view, squinting eyes, open mouth), then a sharp forward jerk with `sneeze-cloud`.
- Weather: `cold` = shiver, chattering mouth, frost and breath puffs, scarf; `hot` = droop, panting, sweat, heat waves, fan-self;
  `rain` = look up, raindrops, umbrella; `snow` = snowflakes, scarf; `sunny` = squint, sparkle, sunglasses; `storm` = rain, lightning, scared;
  `wind` = sway, hair pushed (body lean), puffs; `fog` = fog puffs, sleepy squint.

## Character config schema (Cast stream and builder)

```js
{
  id: 'seira', name: 'Seira', gender: 'f',     // 'f' | 'm' | 'u'
  style: 'seira',                              // base style id
  hairColor: null,                             // hex; null keeps the native color (only for recolor: false)
  shell: '#ECEEF1', screen: '#0C0F14',
  eyes: 'pill', eyeColor: '#FF2A57', lashes: true,
  brows: 'none',                               // 'none' | 'thin' | 'thick' | 'angled'
  mouth: 'smile', blush: false,
  accessories: [],                             // at most 3 ids
  hands: true,
  personality: 'calm'                          // 'calm' | 'cheerful' | 'cool' | 'playful' | 'shy' | 'proud'
}
```

## How to test

1. Read generated PNG files directly to check them.
2. For the runtime, write a demo module and bundle it:
   `python3 brand/mascot/live/tools/bundle.py <demo.js> .explore/<name>.html --title "<title>"`.
   Some browser panes do not open local pages above about 500 KB and cannot reach sibling files. Put images in the page as
   data URLs for tests, and take headless screenshots with `brand/mascot/live/tools/shot.sh` (reads `SHOT_*` from `brand/.env.local`).

## Change requests

- Stickers stream: accessories in slot `face` (`glasses`, `sunglasses`) use `"anchor": "eyes"`. Define `eyes` as the midpoint between the two eyes on the visor, as the runtime draws them. The sticker pivot is the bridge of the glasses.
- Stickers stream: `hands` entries add `width` (drawn width in head radii). All hand sprites share one scale, so the runtime can use this value.
- Stickers stream: an accessory with a side look adds `pivots` and `widths` (for example `pivots.yaw45`, `widths.yaw45`) next to `files`.
- Stickers stream: `fx` entries add `mode`: `single`, `variants` (pick one frame for each particle), or `sequence` (play in order). All frames of one id have the same size.
- Bases stream (done): tall hair did not fit above the pivot (512, 452). The `bun` and `spiky` frames now use a lower pivot: (512, 490) and (512, 491). `messy` uses (512, 457). r stays 300 and every other style keeps (512, 452). The pivot is the same for all views of a style; read it from `manifest.json`. One pivot for all styles does not fit in 1024 px: the tallest hair needs 474 px above the pivot and the longest hair 548 px below it.
