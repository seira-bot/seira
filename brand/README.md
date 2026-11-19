# Seira brand guide

This page tells you how to write and show the Seira name, tagline, logo, and character.
Use it for docs, store listings, release notes, posts, and screenshots.
[DESIGN.md](../DESIGN.md) covers the app interface. The [agent notes](AGENTS.md) cover the scripts in this folder.

## Name

| Use | Write |
|-----|-------|
| Product name in text | **Seira**: capital S, then lowercase. |
| Wordmark and website | **seira.bot**: all lowercase, only in the logo and in links. |
| GitHub organization and npm scope | `seira-bot` (for example `seira-bot/seira`, `@seira-bot/seira`). |
| The hosted service | **Seira Cloud**, or "the Cloud" after the first use. |
| The character | **Seira**. The character and the product have the same name. |

Do not write "SEIRA", "SeiraBot", "Seira Bot", "Seira.bot", or "the Seira app" as a name.
Do not translate the name.

## Tagline and descriptions

Use these lines without changes. One message in every place makes the brand easy to remember.

| Length | Text | Where |
|--------|------|-------|
| Tagline | Your own team of AI agents in one chat app. | README, website title, GitHub description, store summaries, desktop entry, npm README |
| Support line | Give each bot a job. Watch it work. Approve the steps that matter. | Under the tagline, in the README and on the website |
| One sentence | Seira is a local-first chat app for running a team of AI agents. | Package descriptions, store descriptions, the first line of a long text |

A store summary can omit the final full stop.

The tagline says "agents", because that is what people search for.
Inside the app and in guides, a teammate is a **bot**.
Claude Code, Codex, Gemini, and the other programs that a bot runs are **agent programs**.

## Voice

Write like a calm, competent colleague.

- Use short sentences and active verbs.
- Say what Seira does today. Do not promise future features.
- Show the result, not the feature list: "Your bot opens the pull request" beats "PR automation".
- Use sentence case for headings. Do not use exclamation marks.
- Use the product words in [DESIGN.md § Words](../DESIGN.md#11-words).

## Logo

Every logo and app icon comes from one master image: the 3D Seira head with its resting face.
`python3 brand/build_logo.py` makes all the files, and `python3 brand/check_logo.py` checks them.
Do not edit a generated file by hand. Change the master or the script, then build again.

| File | Use |
|------|-----|
| `brand/logo/seira-head.png` | Master image of the head |
| `brand/logo/svg/seira-lockup.svg`, `seira-lockup-reversed.svg` | Head and wordmark together, on light or dark backgrounds |
| `brand/logo/svg/seira-wordmark.svg`, `seira-wordmark-reversed.svg` | Wordmark alone, when the head is already on the page |
| `brand/logo/png/icon-*.png` | App icons (180, 192, 512, 1024 px) |
| `brand/logo/png/mark-*.png` | The head alone, without a tile |
| `brand/logo/favicon.ico`, `brand/logo/png/favicon-*.png` | Browser tabs |
| `docs/assets/brand/` | Copies for the README and the docs, plus the social preview image |

Rules:

- Use the reversed files on dark backgrounds.
- Do not stretch, rotate, recolour, or crop the head.
- Do not add shadows, outlines, or effects.
- Do not draw a new face on the visor. The faces come from `brand/mascot/runtime/face.js`.
- Do not put the logo of another product next to the Seira logo in a way that suggests a partnership.

## Colours

| Name | Hex | Use |
|------|-----|-----|
| Ink | `#0E1116` | Wordmark, icon tile, dark backgrounds, badges |
| Eye red | `#FF2A57` | The eyes and face on the visor only |
| Accent red | `#E11D48` | One highlight per page or badge row |
| White | `#FFFFFF` | Backgrounds and reversed wordmark |

The app interface uses the colour tokens in [DESIGN.md § Colour](../DESIGN.md#3-colour), not these hex values.

## Character

Seira is a white 3D robot head with silver hair panels, a black visor screen, red eyes, and a small smile.
The character shows a state, not decoration: asleep, working, thinking, happy, sad, or alert.
The app draws it with `SeiraCharacter`. The live character code follows [`mascot/live/CONTRACT.md`](mascot/live/CONTRACT.md).
Use at most one character in one view or one image.

Reference images:

- [Expressions](../docs/assets/brand/seira-expressions.jpg)
- [Turnaround](../docs/assets/brand/seira-turnaround.jpg)
- [3D head](../docs/assets/brand/seira-3d.png)

## Upstream attribution

Seira started from OpenMausBot 0.1.169 on 18 November 2026.
OpenMausBot and MausBot are trademarks of another company ([LICENSING.md](../LICENSING.md)).

- Write the upstream names only in attribution (`LICENSING.md`, `NOTICE`, the README credits), in links to upstream issues, and in technical names that the code still uses.
- [docs/upstream-names.md](../docs/upstream-names.md) lists the technical names that still come from upstream.
- Do not use the upstream names, logo, or mascot in product copy, screenshots, store listings, or posts.
- Do not say or suggest that the upstream project endorses Seira.

## Check a change

Before you merge a change to docs or a listing, run this from the repository root:

```bash
git grep -nE 'OpenMausBot|MausBot|OpenMaus|\bMaus\b' -- '*.md' '*.mdx' ':!docs/superpowers' ':!docs/plans' ':!third_party'
```

Every result must be attribution, an upstream link, or a name in the upstream names page.
