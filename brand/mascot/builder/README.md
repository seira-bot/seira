# Character builder

A static page. It lets a person build a seira.bot character and save it as JSON.

## Open the page

Serve the folder `brand/mascot` with any static file server. Open `builder/index.html`.
The page needs `runtime/bot.js`, `art/bases/manifest.json`, `art/stickers/manifest.json`, and `cast/cast.json`.
A data file that is missing does not stop the page. The builder then uses the id lists of `live/CONTRACT.md`.

## Files

| File | Use |
|------|-----|
| `index.html` | Page shell. It loads `main.js`. |
| `main.js` | Entry. It loads the runtime and the data files, then calls `mountBuilder`. |
| `builder.js` | The builder. It exports `mountBuilder(root, { runtime, bases, stickers, cast, baseUrl })`. |
| `icons.js` | SVG icons for eyes and mouths. |
| `builder.css` | Styles. |

`mountBuilder` takes the runtime module as an argument. A test can pass a stub with the same exports.
It returns `{ bot, getConfig(), loadPreset(id), destroy() }`.

## URL query keys

| Key | Value |
|-----|-------|
| `preset` | A character id from `cast.json`. |
| `expr` | An expression id. |
| `state` | A state id. |
| `weather` | A weather id. |
| `gender` | `f`, `m`, or `u`. |

## What the runtime and the manifests must give

- The runtime exports `createBot` and the catalogs `EYES`, `MOUTHS`, `EXPRESSIONS`, `ACTIONS`, `STATES`, `WEATHER`.
  A catalog can be an array of ids, an array of `{ id, label }`, or an object keyed by id.
- `createBot(el, config, { bases, stickers, baseUrl })` can return a Promise.
  `play(id)` must return a Promise.
- Each style in the bases manifest has `label`, `gender`, and `recolor`.
- Each accessory in the stickers manifest has `label` and `slot`.
- The builder allows at most 3 accessories and at most 1 for each slot.
