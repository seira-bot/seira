# Cast presets

This folder holds the character presets of seira.bot. Seira is the first preset and the main logo character.
The other 25 presets are original bots with their own names, colors, and tempers.

| File | Content |
|------|---------|
| `cast.json` | Array of presets. Seira is first. Each preset follows "Character config schema" in `../live/CONTRACT.md`. |
| `concept/lineup-female.png` | Concept sheet: 9 female bots (Seira and 8 more). Cell 1 holds the real Seira art. |
| `concept/lineup-male.png` | Concept sheet: 8 male bots. |
| `concept/lineup-male-2.png` | Concept sheet: 9 more male bots. |
| `concept/expressions-1.png`, `concept/expressions-2.png` | Concept sheets: 24 Seira expressions. |
| `prompts.sh` | The prompts and the generator calls for all sheets. |
| `gen.log` | One line for each generator try: sheet, size, time, retries. |
| `raw/` | Raw generator output. `concept/` holds the finished sheets. |
| `tools/validate.py` | Checks every preset against the contract ids and the schema. |
| `tools/place_seira.py` | Puts the real Seira art into cell 1 of the female lineup. |
| `tools/avatars.py` | Makes Seira's hair style pictures and the accessory stickers for the desktop avatar. |

## Preset fields

Each preset has all contract fields: `id`, `name`, `gender`, `style`, `hairColor`, `shell`, `screen`, `eyes`, `eyeColor`,
`lashes`, `brows`, `mouth`, `blush`, `accessories` (at most 3), `hands`, `personality`.
One extra field helps the cast tools and the builder:

- `sheet`: the concept sheet that shows the bot.

`style` is one of the 17 base styles. Seira uses `style: "seira"` and `hairColor: null`.
Every other preset uses a recolor style and a hex `hairColor`.
Every preset keeps the contract shell `#ECEEF1` and screen `#0C0F14`.

## How to check

```bash
python3 brand/mascot/cast/tools/validate.py
```

The command checks ids, enums, hex colors, the style and gender match, the accessory limit, and the Seira preset.
It prints the preset count and exits with code 0 when all presets are valid.

## How to make the sheets again

Set `SEIRA_IMAGE_CMD` in `brand/.env.local` (see `brand/.env.example`). Then run:

```bash
brand/mascot/cast/prompts.sh lineup-female lineup-male
```

Pass sheet names to make only those sheets. Pass no name to make all sheets.
The script makes at most 2 images at the same time. It stops after 3 failures in a row.
It writes the raw image to `raw/` and the finished sheet to `concept/`.

The generator draws Seira again in each sheet, so cell 1 of the raw female lineup is only a lookalike.
`tools/place_seira.py` removes that head and pastes the head of `../options/d-companion-bot.png` at the same place and height.
The script uses the cell position that `CELL1` gives. If you make the female lineup again, measure `CELL1` again.
Do not use a generated Seira as logo art. Use the files in `../options/` and `../../logo/`.

## How to make the avatar pictures

A bot wears Seira's head with one hair style of `../art/bases/`, and up to three accessory stickers.
The desktop avatar picker shows the 17 hair styles, Seira first. The body id is the style id.
The picker also offers the 25 cast characters from `shared/cast-characters.ts`. That file must match `cast.json`; `shared/cast-characters.test.ts` checks it.
Each style is a rendered head with an empty visor. The app draws the eyes, the mouth, and the accessories.
Run the script after you change a base frame or an accessory sticker:

```bash
python3 brand/mascot/cast/tools/avatars.py
pnpm gen:carved
```

Pass style ids to make only those styles. The script makes no new images.
It uses the front base frame of each style and paints the hair in Seira's silver with the rules of `../runtime/recolor.js`.
Seira keeps her own pictures in `src/assets/seira-body/`.

The script writes these files:

| File | Content |
|------|---------|
| `src/assets/seira-hair/<style>/front-<px>.webp` | The head, with the hair in Seira's silver. |
| `src/assets/seira-hair/<style>/hair-<px>.webp` | The hair only, in neutral grey. The app tints it with the bot color. |
| `scripts/mascot-bodies/hair-geometry.json` | The eyes, the mouth, and the outlines in the 240-unit avatar square. |
| `src/assets/seira-accessory/<id>.webp` | The accessory stickers. |
| `src/assets/seira-accessory/placement.json` | The head radius and the anchors of each style, and the size and pivot of each sticker. |

`pnpm gen:carved` reads `hair-geometry.json` and writes the flat bodies.
With the silver or chrome bot color, the hair stays silver. Other bot colors tint the hair.
The app puts each accessory on its anchor, as `../runtime/bot.js` does. Glasses and sunglasses sit on the eyes.

## Design rules

- Each bot has its own hair color, eye color, and temper. No bot copies a costume, an emblem, or official art of another work.
- The temper decides `personality`, `eyes`, `brows`, and `mouth`. Calm bots get soft eyes and a flat mouth. Hard bots get sharp eyes and angled brows.
- An accessory stands for a trait, not for an outfit. Glasses stand for a clerk or a scientist. A headset stands for an idol or a guard. A tiara stands for a leader.
- The presets use 16 of the 17 base styles. The style `none` has no preset yet.
- There are 25 bots and 16 recolor styles, so some bots share a style. Bots that share a style have different colors.
- Only face 7 of `expressions-2` (dizzy) has spiral eyes. Sick has droopy eyes, a green glow, and a thermometer.

## Presets

### Female (sheet `lineup-female`)

| id | Style, hair color | Eyes, color | Mouth, brows | Accessories | Personality | Why |
|----|-------------------|-------------|--------------|-------------|-------------|-----|
| `seira` | `seira`, native silver | `pill`, red `#FF2A57` | smile, none | none | calm | Fixed by the contract. Quiet and straight. |
| `mira` | `long-straight`, dark brown-black | `round`, amber | smile, thin | hairpin | shy | Long straight dark hair, timid and kind. Blush. |
| `lumi` | `bob`, dark turquoise | `star`, aqua | cat, thin | headset-mic, earring | cheerful | Star eyes and a headset stand for an idol. |
| `rhea` | `ponytail`, deep red | `sharp`, crimson | flat, angled | glasses, earring | cool | Red high ponytail, glasses, stern and loyal. |
| `kiri` | `long-wavy`, near black | `almond`, red | fang, angled | earring, hairpin | playful | Long wavy black hair. A cheerful face with a sharp edge. |
| `iris` | `seira-long`, purple | `round`, coral red | smile, thin | hairpin, ribbon | calm | Purple hair, gentle and dutiful. Soft blush. |
| `vera` | `long-straight`, light brown | `sharp`, pink | smirk, angled | earring | proud | Light brown hair and pink eyes. Cynical and proud. |
| `pippa` | `twin-tails`, copper brown | `round`, blue | grin, thin | ribbon | cheerful | Lively, young, and talkative. |
| `maren` | `bun`, black | `almond`, crimson | flat, angled | tiara | proud | Black hair in a bun. Strict and severe. The tiara stands for a leader. |

### Male, first sheet (`lineup-male`)

| id | Style, hair color | Eyes, color | Mouth, brows | Accessories | Personality | Why |
|----|-------------------|-------------|--------------|-------------|-------------|-----|
| `corvin` | `center-part`, jet black | `almond`, scarlet | flat, thin | earring | calm | Black hair, scarlet eyes, quiet and distant. One earring only. |
| `felix` | `long-loose`, blond | `almond`, bright blue | smirk, angled | glasses, bowtie | playful | A cheerful face with a sharp grin. |
| `silas` | `slick-back`, silver | `sharp`, crimson | smirk, angled | bowtie | proud | Swept-back silver hair. Proud and elegant. |
| `flint` | `messy`, silver-grey | `sharp`, pale grey | flat, angled | headset-mic | cool | Grey eyes, cold at first. The headset stands for a guard. |
| `bix` | `short-neat`, black | `round`, turquoise | grin, thin | headphones, glasses | playful | Black bowl-cut hair. A relaxed technology fan. |
| `theo` | `long-tied`, violet | `round`, blue | smile, thick | scarf | cheerful | Long purple hair in a tail. Kind and patient. |
| `rocco` | `spiky`, bright red | `round`, blue | grin, thick | headphones | cheerful | Bright red hair, energetic. |
| `milo` | `buzz`, brown | `round`, amber | small-o, thin | glasses, antenna | shy | A nervous face. The antenna stands for a technology fan. |

### Male, second sheet (`lineup-male-2`)

| id | Style, hair color | Eyes, color | Mouth, brows | Accessories | Personality | Why |
|----|-------------------|-------------|--------------|-------------|-------------|-----|
| `leo` | `short-neat`, blond | `sharp`, crimson | smirk, angled | bowtie | playful | Short blond hair, haughty and cheeky. |
| `aldo` | `slick-back`, white | `sharp`, crimson | flat, thick | none | proud | Old, white swept-back hair. Strict and short-tempered. |
| `orin` | `long-loose`, grey | `sharp`, pale grey | grin, thick | none | cool | Long grey hair. A calm and confident old warrior. |
| `rico` | `long-tied`, bright blond | `star`, crimson | grin, thin | sunglasses, earring | cheerful | Long blond hair. A showy braggart. |
| `rook` | `messy`, brown | `sharp`, crimson | flat, angled | earring | cool | Short brown hair with a ragged fringe. Serious and cold. |
| `ronan` | `long-loose`, dark red | `sharp`, crimson | fang, angled | earring | playful | Long red hair. Loud, jealous, and explosive. |
| `bruno` | `spiky`, light grey | `square`, brown | fang, thick | none | proud | Mohawk-like hair. Big, rough, and proud. |
| `ansel` | `slick-back`, grey | `almond`, golden amber | smirk, thin | glasses | calm | Grey hair and glasses. A calm and mysterious scientist. |
| `ellis` | `center-part`, blond | `almond`, golden yellow | smile, thin | glasses, bowtie | calm | Polite, neat, always smiling. |

## Rights note

Seira is the product mascot. The other 25 bots are original robot designs with original names.
The image generator received only the Seira reference art from `../options/`, no third-party art.
