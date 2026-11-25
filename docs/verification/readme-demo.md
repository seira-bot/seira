# The README demo

The short demo at the top of the README is made by a script. A person does not
record it by hand. The script uses only synthetic data, so the clip can show no
real account, path, host name, or user data.

## What the script does

`scripts/record-readme-demo.mjs` starts a sealed server with a temporary home
and the repository's fake engine (`FAKE_ACP_MODE=permission`). It creates three
sample bots (Scout, Mira, Atlas) and opens the built web UI in a headless
Chromium that has video recording on. Then it plays the main loop:

1. The person types a job to Scout.
2. An approval card asks to run `pnpm test`.
3. The person clicks **Allow once**.
4. Scout answers that all tests passed.

The clip is about 15 seconds. The script cuts off the loading screen at the
start. It writes three files: `demo.webm` (raw), `demo.mp4` and `demo.gif`.

## Run it

Build the UI first (`pnpm exec vite build --outDir <dist>`). The script needs a
Chromium, `playwright-core`, and `ffmpeg` on the PATH. The end-to-end UI tests
take the same inputs.

```sh
node scripts/record-readme-demo.mjs \
  --chromium <path to Chromium> \
  --playwright-core <folder of playwright-core> \
  --dist <vite build folder> \
  [--out <folder>] [--port <free port>]
```

Use a `playwright-core` version whose `ffmpeg` build matches the `ffmpeg`
folder in your Playwright browser cache. If the two do not match, Playwright
writes no video and the script stops with an error.

If a step cannot find its element, the script saves `stopped.png` in the output
folder. The screenshot shows where the run stopped, which is usually a change
in the app.

## Before you commit a new clip

1. Check that no frame shows the words "fake", "mock" or "test" in the app itself (the job text and the command `pnpm test` are fine). The script gives the fixture model the name "Demo model" through a `config.toml` in the temporary home. Do not use the name of a real model. A quick check: run `tesseract` over frames cut with `ffmpeg -vf fps=2`.
2. Look at every frame. Check for real account names, paths, host names, IP
   addresses, and user data.
3. Keep `docs/screenshots/readme-demo.gif` below about 5 MB.
4. Run `node scripts/check-local-leaks.mjs` and `node scripts/check-brand-names.mjs`.
5. Keep the static screenshot below the clip in the README as a fallback.

Update the clip when the chat screen or the approval card changes in a way
that a person can see.
