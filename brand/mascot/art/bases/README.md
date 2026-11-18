# Base frames

Base frames of the seira.bot character for the 2D canvas runtime.
The interface is `brand/mascot/live/CONTRACT.md`, section "Bases".

Each of the 17 hair styles has 7 views: `front`, `yaw20`, `yaw45`, `side`, `back`, `up`, `down`.
Each view is a 1024 × 1024 RGBA frame with a hair mask, a visor mask, a pivot, a radius, and anchors.
The visor screen is switched off in every frame, so the runtime draws the face.

## Files

| Path | Content |
|------|---------|
| `manifest.json` | One entry for each style and view (format in `CONTRACT.md`) |
| `out/STYLE/VIEW.png` | The frame: RGBA, head radius r = 300 px, pivot at (512, 452) or lower for tall hair |
| `out/STYLE/VIEW.hair.png` | Hair mask (L, white = hair). Not written when no hair shows. |
| `out/STYLE/VIEW.visor.png` | Visor mask (L, white = screen). Not written when the screen does not show (`back`). |
| `raw/STYLE-SHEET.png` | The generated sheets, on chroma green. `*.old.png` files are earlier takes. |
| `prompts.sh` | Makes the raw sheets with gpt-image-2.6 |
| `gen.log` | One line for each generation: file, size, time, retries |
| `tools/process.py` | Raw sheets to frames, masks, and manifest entries |
| `tools/check.py` | Checks the manifest and the frames. Exit code 0 means every check passed. |
| `tools/contact.py` | Contact sheets for a visual review, in `contact/` |

## Make the frames again

1. Set `SEIRA_IMAGE_CMD` in `brand/.env.local`. See `brand/.env.example` for the command contract.
2. Make the raw sheets. At most 2 generations run at the same time.

   ```bash
   brand/mascot/art/bases/prompts.sh seira:a seira:b seira:c
   ```

3. Make the frames, the masks, and the manifest entries.

   ```bash
   python3 brand/mascot/art/bases/tools/process.py seira seira-long bob
   ```

4. Check the result and look at the contact sheets.

   ```bash
   python3 brand/mascot/art/bases/tools/check.py
   ```

   ```bash
   python3 brand/mascot/art/bases/tools/contact.py
   ```

Make `seira` first: the sheets of every other style use `raw/seira-a.png` as the style reference.
`seira-long` is a twin of `seira`: the same image with magenta hair.
`process.py` uses the twin to make the hair masks of the silver `seira` style.

## Sheets

| Sheet | Layout | Views taken |
|-------|--------|-------------|
| a | 2 × 2 | top left `front`, top right `yaw20`, bottom left `yaw45` |
| b | 2 × 2 | top left `back`, top right `up`, bottom left `down`. The front view at the bottom right sets the scale. |
| c | 1 × 2 | right `side` (a true 90° profile). The front view at the left sets the scale. |

The bottom right cell of sheet a turns about 65°. It is not used.

## How `process.py` measures each frame

- **Keying.** The alpha comes from the distance to the green background color and from the hue ratio, so shaded green also becomes clear. The script un-mixes the edge colors from the green.
- **Hair mask.** The magenta hue gives the hair mask. For `seira`, the script registers the magenta twin to the silver sheet and moves the twin hair mask.
- **Visor mask.** The largest dark area that is not hair, with holes filled.
- **Scale.** The front view of each sheet sets r for the whole sheet.
  - Hair styles: r comes from the visor width. The hair never covers the sides of the visor in the front view.
    `out/calibration.json` holds the shell radius for each visor pixel, measured on the `seira-long` front view.
  - Bare shells (`none`, `buzz`) show at least 200° of their outline. A free circle fit on that outline gives r.
- **Pivot.** Front view: a circle of radius r fitted to the chin arc of the shell. The pivot x is the visor center.
  Other views: a circle of radius r fitted to the bare shell outline (not hair, not visor).
  When too little shell shows, the pivot x is the middle of the head silhouette, and the pivot y comes from the chin or the head top.
  Hair on the back of a turned head pulls the silhouette middle away from the sphere center, so the silhouette is only the fallback.
- **Frame.** Each frame is 1024 × 1024 with r = 300 px. The pivot is (512, 452).
  A style with tall hair gets a lower pivot y, the same for all its views, so that 16 px stay clear above the hair.
  Now `bun` uses (512, 490), `spiky` (512, 491), and `messy` (512, 457). Read `pivot` from the manifest for each view.
  One pivot for all styles does not fit: the tallest hair needs 474 px above the pivot and the longest hair 548 px below it.
- **Yaw.** `measuredYaw` comes from the visor width compared with the front visor width. The pivot does not enter this value.
- **Pitch.** `measuredPitch` comes from the vertical visor shift compared with the front view of sheet b.
- **Anchors.** The script turns head points by the measured yaw and pitch and projects them. An anchor on the far side of the head is left out. `top` comes from the frame alpha.

## What `check.py` checks

| Check | Rule |
|-------|------|
| coverage | All 17 styles and 7 views are in the manifest. Every listed file exists and is 1024 × 1024. |
| scale | r = 300 in the manifest. All views of a style have the same pivot, with x = 512 and y = 452 or more. The measured shell radius of the front view is 300 ± 6 px. |
| visor | A visor mask exists for `front`, `yaw20`, `yaw45`, `up`, `down`. |
| hair | Every view of a recolor style has a hair mask. |
| center | Front view: the visor centroid x is 512 ± 20, and the visorBox reaches the same distance (± 20 px) left and right of the pivot. |
| turn | The visor centroid moves right from `front` to `yaw20` to `yaw45` to `side`. `measuredYaw` is 10–30 for `yaw20`, 30–60 for `yaw45`, 70–90 for `side`. |
| pitch | `measuredPitch` is above 0 for `up` and below 0 for `down`. |
| pivot | In every view except `front`, a circle of r = 300 on the bare shell outline is centered on the pivot ± 12 px. Views where hair hides most of the shell are listed as "not measured". |
| clear | Hair covers no more than 3% of the visor outline. A warning starts at 1%. |
| edge | No frame has an alpha above 16 (of 255) in its outer 1 px row or column. |

The shell radius check is strong for `none` and `buzz`, where a free circle fit measures it.
For a hair style it measures the distance from the pivot to the chin, which `process.py` also uses to place the pivot.

## Known gaps

- **The pivot of some views is not measured.** Hair hides most of the shell in most `side` and `back` views and in every `slick-back` view except `front`.
  There the pivot comes from the head silhouette and can be off by about 20 px.
- **The generator does not keep one head size across cells.** Each sheet takes its scale from its own front view, so a turned view can be a few percent larger or smaller.
- **Pitch is not symmetric.** `up` measures 11–38° and `down` −8 to −22°, as the generator drew them.
- **`messy` hair touches the visor** in `yaw20` and `down` (about 1.2% of the visor outline).

## Raw sheets

The raw sheets in `raw/` are not in the repository, because they add about 69 MB.
The runtime and the builder need only `out/` and `manifest.json`.
`tools/process.py` needs `raw/` to build `out/` again.
To get the sheets, ask a maintainer for the source archive, and unpack it into `raw/`.
