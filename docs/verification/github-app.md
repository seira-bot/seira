# GitHub native connection

Apps shows a GitHub tile that connects through the Seira GitHub App. A bot can
use only the repositories its owner gives it, at the level the owner picks:
Read, Pull requests or Write. Only the person who connected GitHub can change
a bot's limits. Everyone else sees them read-only. The feature is off unless
`SEIRA_GITHUB_APP=1` or `features.githubApp` is set.

## Isolated browser verification

Use an installed Playwright module and Chromium executable
(`SEIRA_VERIFY_PLAYWRIGHT`, `SEIRA_VERIFY_BROWSER_CHROME`), then run:

```sh
SEIRA_UI_EVIDENCE_DIR=/tmp/seira-github-app-evidence \
  node --experimental-strip-types scripts/verify-github-app.ts
```

It starts three fake-engine servers with the flag on, and one loopback
stand-in for the GitHub broker (`server/testing/github-broker-fake.ts`). Each
server has its own temporary data folder. It drives the real Apps pop-up and
bot panel, and checks:

- With no connection, the GitHub tile is in Featured with a Connect button
  and a Bot access section.
- As the owner, the tile lists both accounts, a pending organization request
  and the bots that use GitHub. The Which bots dialog has one switch per bot.
- The bot's Apps page shows a Repositories row. The bot GitHub page lists
  each repository with its level and the two rules.
- Changing a level on the level page is stored: `GET /api/github-app` shows
  the new level and leaves the other repository as it was.
- The add-repositories page marks added repositories and shows private ones.
- Per-app tools (Advanced) shows the bot's repositories and levels above the
  GitHub tool list.
- As another person, the tile, the dialog and the bot pages are read-only,
  say who can change them, and have disabled switches and no add or remove
  controls.
- `PUT /api/github-app/bots/<botId>` from that person answers 403 and leaves
  the stored policy unchanged.

It saves one screenshot per state and a `result.json` with every check. The
checks for the acceptance criteria carry their id (AC-01, AC-06, AC-17).

## What it does not prove

- No real GitHub, broker or Composio call is made. The browser sign-in on
  GitHub and the broker's own routes are not exercised.
- A bot's tools do not run here. The tool rules are covered by
  `server/github/tools.test.ts` and `server/github/host.test.ts`.
- Only the desktop owner and a person who is not the owner are compared. Team
  and signed-in people use the same owner check but are not driven here.
