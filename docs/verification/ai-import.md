# Move from another AI

What it covers: the **Move from another AI** hub in Settings, Import & export. It lists the sources, reads an
export file or a local app, shows what it will bring in, brings it in, reports the result, and undoes it.

Screenshots were kept outside the repository. Checked on 2026-11-21 on a throwaway tree: `origin/main` (7678003f2) plus the heads of the exports, local and hub
pull requests (f1332df1d, a1e8a64a1, e309b3d0f). The fake engine runs the fixture. The data folder and the port
are temporary. Port 8799 and the installed app's data folder were not used.

```sh
node --experimental-strip-types scripts/control-seira.ts ui launch
# then, per step: control-seira ui eval | click | screenshot --ui HANDLE
```

The control surface has no import verbs. The steps below drive the real Settings screen with `ui eval`, and
read the state through the page's own `fetch` of `/api/bots`, `/api/routines` and the import jobs list.

## Inputs

- A ChatGPT export ZIP with `conversations.json`, `user.json` and `message_feedback.json` from
  `server/ai-import/fixtures/chatgpt/single`, built with `buildZip` (`server/testing/zip-fixture.ts`).
  The ZIP holds no attachment files, so the 3 attachments it names cannot be read.
- A Hermes home: `server/ai-import/fixtures/hermes` copied to `<data dir>/.hermes`. The fixture sets `HERMES_HOME`.
- The preview is a browser page, so it is not "this computer" for the app. To show the local sources, the check set
  `window.ogb = { remoteClient: { active: false } }` in the page, as the desktop shell does. Before that, the hub
  showed the note for other computers, and no local rows.

## Results

| AC | Step | Result | Screenshot (file name) |
|----|------|--------|------|
| AC-01 | Open Settings, Import & export. | The hub lists ChatGPT, Claude.ai, Grok Bot and Another AI, and the drop zone. With the desktop bridge set, it also lists the 2 Hermes homes under "On this computer". | `01-hub.png`, `06-hub-local.png` |
| AC-31 | Choose ChatGPT, send the ZIP (file input `change`). | "Review what Seira found": Chats 2, Messages 7, Memories 1, Files 3, "Goes to: A new bot", and "4 items could not be read". | `03-review-chatgpt.png` |
| AC-31 | Press **Bring in** on Hermes. | Review: Memories 4, Skills 2, Tools 2, Routines 4, Channels 2, "2 items could not be read". | `07-review-hermes.png` |
| AC-42 | Press **Import** on the ChatGPT review. | "Partly brought in": Brought in 4, Not brought in 4, an undo date (11/28/2026). The bot list went from Pepper, Fixture Starter to ChatGPT, Pepper, Fixture Starter. The ChatGPT bot has 3 tasks. | `04-report-chatgpt.png` |
| AC-42 | Press **Import** on the Hermes review. | Report: Brought in 12, Not brought in 2, and "What is left for you": add key (github, docs), connect again (telegram, discord), resume routine (4). Bots: Hermes added. Routines: 0 to 4. | `08-report-hermes.png` |
| AC-44 | Press **Undo** on the ChatGPT report. | "Undone: 5 removed, 0 restored." The bot list is Pepper, Fixture Starter again. Job state is `undone`. | `05-undone-chatgpt.png` |
| AC-44 | Press **Undo** on the Hermes report. | "Undone: 13 removed, 0 restored." Bots are Pepper, Fixture Starter. Routines are 0 again. | `09-undone-hermes.png` |

## Found while checking, and fixed

- A local source row for a profile read "Hermes · work · work". The row now shows the source name once.
- A local source row described itself with its name. It now shows the line for its kind.
- The "What is left for you" list named the header and variable names a tool needs. It now says "add the key for <tool>".

## Not proven

- The fake engine and a hand-made ZIP prove the screen and the server state, not a real ChatGPT export, which can
  be several GB, or a real Hermes home.
- The desktop bridge was set by hand in the page. The check does not prove the desktop shell sets it.
- Undo of an item the person changed after the import ("kept because you changed them") was not run.
- The report lists the Hermes secrets only as names of keys. The check did not search the server log for values.
- The Paste step, Claude.ai and the Grok Bot row were not run.

## Hermes export file

What it covers: the **Hermes on another computer** row. Hermes follows the copied steps and makes one ZIP with
`seira-import.json`; the person drops that ZIP here.

Checked on 2026-11-23 on `feat/hermes-export-file` (7e855be6a) with `control-seira ui launch`. The fake engine runs
the fixture. The data folder and the ports are temporary.

### Inputs

- A valid export, built with `buildZip`: two agents (`hermes` with a persona, 2 About you entries, 3 memories, one
  skill, a cron routine, an `in 30m` routine and `telegram`; `research-desk` with one memory), `timeZone`
  `Asia/Jakarta`, a fixed `instance`.
- The same ZIP plus `agents/hermes/skills/daily-brief/.env`.
- Each ZIP went in through the guide's file input (`change`), as in the checks above.

### Results

| AC | Step | Result | Screenshot (file name) |
|----|------|--------|------|
| AC-01 | Open Import & export. | The hub lists "Hermes on another computer" with its line, above ChatGPT. | `10-hermes-guide.png` |
| AC-12 | Choose it, press **Copy**. | Three steps show. The button reads Copied. The clipboard holds the 8,243-character skill text with the manifest name and the private-chat rule. | `11-hermes-copied.png` |
| AC-02, AC-05 | Drop the ZIP with `.env`. | "Nothing was imported" and "This file holds a password or key file, so Seira did not open it. Make the export again and leave that file out." No bot came in. The server log has no `API_KEY`. | `12-secret-file.png` |
| AC-01, AC-09 | Drop the valid ZIP. | Review: Hermes with Memories 5, Skills 1, Routines 1, Channels 1; Research desk with Memories 1; "1 items could not be read". | `13-review-export.png` |
| AC-08 | Press **Import**. | "Partly brought in": Brought in 8, Not brought in 1; connect again telegram; resume Morning brief. Bots: Research desk, Hermes added. The routine is paused, cron `30 7 * * 1-5` in `Asia/Jakarta`. | `14-report-export.png` |
| AC-11 | Drop the same ZIP again. | The review picks Hermes and Research desk as the targets, not a new bot. | `15-reimport-review.png` |

### Not proven

- The headless browser has no real clipboard. The check replaced `navigator.clipboard.writeText` in the page and
  read what the hub wrote.
- No real Hermes ran the steps. The ZIPs were built by hand to the format the skill text gives.
- The nested archive and broken manifest paths are proven by `server/ai-import/hermes-export.test.ts`, not on screen.
