# Brand assets: agent notes

This folder holds the Seira logo, mascot images, and the character code.
The [brand guide](README.md) sets the rules for the name, tagline, logo, colours, and upstream names.
The root `AGENTS.md` applies here too, including "Local details stay local".

## Machine values

Copy `brand/.env.example` to `brand/.env.local` and fill in your values. Git ignores `brand/.env.local`.

| Variable | Used by | Required |
|----------|---------|----------|
| `SEIRA_IMAGE_CMD` | `mascot/**/prompts.sh` | yes, to make mascot images |
| `SHOT_HOST`, `SHOT_CHROMIUM`, `SHOT_MEM` | `mascot/live/tools/shot.sh` | no |

Rules for scripts in this folder:

1. Set `BRAND` to this folder and source `load-env.sh`. It loads `brand/.env.local`.
2. If a required value is missing, stop with a message that names the variable and `brand/.env.example`.
3. Find files relative to the script, never with an absolute path.
4. Write logs without user names, home folders, or host names. Use `wc -c`, not `ls -l`.

## Commands

| Purpose | Command |
|---------|---------|
| Build the logo files | `python3 brand/build_logo.py` |
| Check the logo files | `python3 brand/check_logo.py` |
| Bundle a demo page | `python3 brand/mascot/live/tools/bundle.py <entry.js> <out.html>` |
| Take a headless screenshot | `brand/mascot/live/tools/shot.sh <page.html> <out.png>` |

`build_logo.py` makes the app icons from `brand/logo/app-icon-source.png`. This is the same image as the mobile app icon.

The character modules follow `brand/mascot/live/CONTRACT.md`.
