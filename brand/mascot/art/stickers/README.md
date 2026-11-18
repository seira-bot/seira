# Seira stickers: hands, accessories, effect sprites

Image sprites for the 2D character runtime. The format is in `brand/mascot/live/CONTRACT.md`, section "Stickers".
`manifest.json` lists every sprite with pivots, slots, anchors, and widths.

## Status

| Group | State |
|-------|-------|
| Hands (11 gestures) | Done. |
| Accessories, front view (12) | Done. `scarf` comes from the third try (`acc-fix`); the ring sheet is kept as `scarf-ring` in `raw/slices/acc-b`. |
| Accessories, `yaw45` view (glasses, sunglasses, headphones, cap) | Done. The third sheet worked: the prompt names all four designs and uses no extra reference sheets. The first two sheets (black background with glow) are kept as `raw/acc-yaw45.rejected-*.png`. |
| Effects (26 ids, 36 frames) | Done. |

`python3 tools/check.py` exits 0 (63 files checked). Known small flaw: `sunglasses` `yaw45` has a few white specks on the inner rim of the lenses.

## Folders

| Path | Content |
|------|---------|
| `prompts.sh` | All prompts and the generator loop. Needs `SEIRA_IMAGE_CMD` (see `brand/.env.example`). |
| `gen.log` | One line for each generation: result, tries, seconds, bytes. |
| `raw/` | Raw sheets on green. `raw/slices/` holds the keyed sprites, `raw/debug/` the slice boxes. |
| `out/hands`, `out/acc`, `out/fx` | Final sprites (PNG, RGBA, trimmed, 8 px padding, at most 512 px). |
| `contact/` | Contact sheets on grey, on dark, and with pivot marks. |
| `tools/` | `process.py`, `keying.py`, `contact.py`, `check.py`, `common.py`. |

## How to make the sprites

1. Make or update a sheet: `./prompts.sh SHEET` (`FORCE=1` keeps the old file as `*.rejected-*.png`). At most 2 run at once.
2. Read the raw sheet. Reject a sheet that has a non-green background, glow, or a wrong item.
3. `python3 tools/process.py slice SHEET` keys the sheet and cuts one file for each item.
4. `python3 tools/process.py finalize` scales, pads, finds pivots, and writes `out/` and `manifest.json`.
5. `python3 tools/contact.py` writes the contact sheets. `python3 tools/check.py` checks the set.

The key reads the green from the sheet border, then each edge pixel takes the color of the nearest solid pixel (no green fringe).

## Sprite rules

- Hands are right hands. The raw art showed left-hand poses, so the tool mirrors all of them except `pat`. `pivot` is the wrist end.
  All hands share one scale. `width` is the drawn width in head radii for that scale (240 px = 0.8 radii).
- Accessory `width` is a design value in head radii. `pivot` is the point that lands on the `anchor`.
  `glasses` and `sunglasses` use anchor `eyes` (see the change request in `CONTRACT.md`). The pivot is the bridge between the lenses.
- An accessory with a `yaw45` look has `files.yaw45`, `pivots.yaw45`, and `widths.yaw45`.
- Effects: `mode` is `single`, `variants` (use one frame for each particle), or `sequence` (play the frames in order, `splash`).
  All frames of one id have the same size, so one `pivot` fits all. Particles are at most 128 px; props are at most 256 px.
  `umbrella` pivot is the grip on the shaft. `lightning` pivot is the top. `splash` pivot is the base line.
- No letters in sprites. `question`, `exclaim`, and `zzz` are the only symbols.

## Raw sheets

The raw sheets in `raw/` are not in the repository, because they add about 31 MB.
The runtime and the builder need only `out/` and `manifest.json`.
`tools/process.py` needs `raw/` to build `out/` again.
To get the sheets, ask a maintainer for the source archive, and unpack it into `raw/`.
