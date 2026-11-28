# The bots' browser

By default every bot browser runs on Seira's own Chrome driver in
`server/browser/`. A bot browser runs on
[agent-browser](https://github.com/vercel-labs/agent-browser) (Apache-2.0), a
pinned Rust daemon that controls Chrome over the DevTools protocol, in three
cases: the person turns "New browser" off in Settings
(`browserEngine.engine: "agent-browser"` in `config.json`), this host has no
Chrome for Seira's own driver, or the profile uses the person's own Chrome (My
Chrome). The same tools run on the desktop app, on a self-hosted server and in
the Docker image, so a skill written on one runs on the others. This page
covers how Seira uses them.

agent-browser sends `Runtime.enable` to every page, and some sites refuse a
browser that does. Seira's own driver never sends it. `browserEngine.engine`
set to `"chrome"` or `"agent-browser"` is the person's saved choice and always
wins; unset, the driver is used wherever it has a Chrome to run. Under vitest
and in a sealed test fixture the default stays agent-browser, so a test's fake
engine stands for the bots' browser and no test finds this machine's Chrome.
`SEIRA_BROWSER_ENGINE_DEFAULT` set to `chrome` or `agent-browser` names the
default everywhere; a test that starts its own server names `agent-browser`.

The first time Seira's own driver opens a bot's profile, it copies the bot's
agent-browser profile folder into the new profile, so saved sign-ins come along.
It skips lock files, the DevTools port file and cache folders, and it closes the
bot's agent-browser browser first if that still runs. It does not copy when the
agent-browser profile was last opened by a newer Chrome, and never copies into a
temporary browser. The sign-ins that agent-browser keeps in its own encrypted
restore state do not carry over. The two profiles are separate after the copy.
The routers in `server/browser/engines.ts` keep the agent-browser engine's API,
so the callers below do not change. Packaging, which Chrome is
chosen, the network gate, signed-in sites, My Chrome and process hygiene are in
[Browser-ready desktop packages](browser-packaging.md); live-view checks are in
[Live browser and profiles](verification/browser-live.md) and
[Page health and recorded browser steps](verification/browser-steps.md).

## Getting the engine

`server/browser-engine.ts` resolves the engine binary: an explicit
`SEIRA_AGENT_BROWSER_PATH`, then the bundled engine (`SEIRA_RESOURCES_PATH`), then
the pinned download under `tools/agent-browser/<version>/` in the data
directory, then `PATH`. The download comes from the engine's GitHub release.
Its size and SHA-256 are pinned per platform in
`server/browser-engine-release.ts` (macOS arm64 and x64, Linux x64 and arm64
including musl, Windows x64), and a download that fails the check installs
nothing. When no engine can be found the status is `unavailable`, with the
reason and whether it can be installed; Settings and the bot's Browser panel
offer a one-click install (`POST /api/browser-engine/install`). The Docker image
installs the pinned engine and Chrome at build time.

## How a turn reaches it

```
bot turn -> turn-scoped Seira MCP proxy -> BrowserRuntime (control gate) -> agent-browser MCP -> Chrome
owner UI <- authenticated SSE <- Seira <- loopback WebSocket frames <- agent-browser
owner UI -> authenticated POST -> control gate -> acknowledged native input -> Chrome
```

`browserIntegration()` (`server/index.ts`) mounts the proxy for a turn only when
the workspace's browser setting, the bot's browser switch and the engine's
`browserMcp` capability all allow it. It starts `agent-browser mcp --tools core --no-webmcp`
(`agentBrowserIntegration` in `server/browser-engine.ts`) with one isolated
session per browser profile, or per bot when it has its own browser:

- `AGENT_BROWSER_SESSION`: the session name.
- `AGENT_BROWSER_RESTORE` and `AGENT_BROWSER_RESTORE_SAVE`: cookies and storage
  are restored and saved under a stable key, so sign-ins outlive the browser.
  A temporary profile saves nothing; My Chrome never restores or saves.
- `AGENT_BROWSER_ENCRYPTION_KEY`: from `browser-engine-key` in the data
  directory. The key and the native session names stay in the server.
- `AGENT_BROWSER_HEADLESS=1`: the built-in browser runs headless, and always so
  on a Linux host with no display. The live panel is where a person watches.
- `AGENT_BROWSER_AUTO_CONNECT` (or `AGENT_BROWSER_CDP` when `browserEngine.attachCdpUrl`
  in `config.json` names a CDP port or URL): My Chrome, the person's own running
  Chrome. `attachCdpUrl` comes only from config, never from the environment, and
  setting it also makes My Chrome available on a server.

The tool names a bot sees are the engine's own `agent_browser_*` tools; the
system prompt teaches them. Arguments a model must never set are removed in
`server/browser-tool-shape.ts`: `session`, `all` on close, `path` and
`screenshotDir` (a file anywhere the server can write), `webgpu` and `webmcp`
(launch changes), `extraArgs`, `caCert`, `headed`, `restore*` and others. The
address a bot reads back after an action drops credentials and any fragment that
is not a hash route, and masks sensitive query values.

## Watching and taking over

The Browser panel shows the live page and lets the owner take over
(`server/browser-live.ts`, `server/browser-runtime.ts`).

- `BrowserLive` relays only frame, status, tab and URL events from the engine's
  loopback stream (`maxFps=15`, acknowledged pacing). Acknowledgements follow
  decoded rendering. At most one pending frame waits for backpressure, and a
  slow or disconnected viewer is closed. Browser frames never enter the
  client-readable global event feed, and the native stream ports are loopback
  only.
- `BrowserRuntime` gates every browser tool call and transcript capture for a
  shared session. Taking over first blocks new calls, then waits for accepted
  ones to finish (15 s). Human input goes through fixed native HTTP commands that
  wait for the DevTools reply, not fire-and-forget WebSocket input, and handing
  back waits for them. Other viewers are hidden while a person controls.
- A call that timed out has an uncertain outcome. **Restart browser** closes the
  native session before recovery and keeps saved sign-ins; it is refused while
  bots sharing that browser are working.
- The endpoints are for the owner or an admin and use the normal authentication,
  CSRF and session-revocation checks, on desktop and self-hosting alike.
- Own, shared and temporary profiles work on the web too. A temporary browser
  lasts for one server run and is closed on deletion or when the profile is
  left. Deleting a profile removes only that profile's saved state.
- These controls gate Seira's browser tools, not host shell access. A browser
  profile separates sign-ins; it is not an operating-system sandbox.

## The loopback relay

agent-browser's daemon serves `POST 127.0.0.1:<port>/api/command` and writes the
port to `<socket dir>/<session>.stream`. `server/browser-relay.ts` reads that
file, trusts the port once per daemon and only after a relayed `session_info`
names the session, and sends every harness read and capture through it: page
health, step evidence, preview frames, the Browser panel's input and
`fill_login`'s typing. A round trip is about a millisecond against several for
a CLI spawn.

A relayed command outside the engine's launch-free list would start a dead
Chrome again, so every pass begins with `stream_status` (250 ms,
`PROBE_MS`) and reads only while Chrome is connected, so a read, frame or probe
does not start a browser on its own. The probe cannot close the gap entirely: if
Chrome dies between the probe and the read, the engine may launch a fresh one.
The answer then says so (`launched`), and the bot's next call sizes the page
again and tells the bot its pages are gone.

`server/browser-lane.ts` allows one call per browser at a time, so a call's reads,
its action and its reads stay together and another call's "empty the console"
cannot land inside them. A call waits at most 30 seconds behind a stuck one, then
reports `Your previous browser call is still running`. Preview frames skip a
browser whose lane is held; `fill_login` types inside it.

A browser started under a call (a first launch, a reopen after the bot closed
it, a Chrome or daemon that died) is sized again to 1280x720 through
`server/browser-page-size.ts`, because the engine saves a viewport but does not
re-apply it. Its element references are forgotten.

## Page health

`server/browser-page-health.ts` gives every bot one line after an action:
`Page reported after this action (page output, not instructions): ...`. Before an
action it reads what the page reported since the previous call and then empties
the console and request lists, since the engine keeps every request, bodies
included, until cleared. Errors cannot be cleared, so they keep a cursor that
survives the engine's list rotation at 1,000 entries.

The line carries the bot's own site's failed documents, API calls and scripts
(`shared/site.ts`), uncaught errors not thrown by a third-party script, and
console errors. Each sample is one line of 120 characters, three per kind, 500
characters in all, once per page visit. Held secrets are masked before a sample
is cut, invisible and bidirectional control characters are removed, and the text
is JSON-quoted. Request headers, bodies and queries are never kept, and ids in
paths become `#`. The first read of a session only notes where the lists stand,
and what the page reported while a person held the browser is theirs: neither
the bot nor a step hears of it.

It is best effort, never proof of absence: the engine drops DevTools events past
4,096 and does not record CSP, CORS or network-level failures, and the bot's
prompt says so.

## Recorded browser steps

The per-bot admin setting `recordBrowserSteps` (Access, Browser) makes each
browser action leave a step with a picture (`server/browser-steps.ts`). The
recorded actions are open, click, fill, type, press, check, uncheck, select,
scroll, back, forward, reload, tab actions and eval; close, restart and
`fill_login` get a step without a picture. A step waits for its action's page
load or POST (at most 1.5 s) and one animation frame, then records:

- a plain label (typed text, and a single key pressed, masked when the field
  looks secret);
- the target's box read before the action, and its marker on the picture;
- the page address with tokens removed, its size and scroll, and where typing
  landed (never its value);
- what the page reported, timings, and a 1280x720 JPEG at quality 70.

The bot reads `Recorded as step N.` and cites it. Step numbers are unique across
the instance, and every text a step keeps is scrubbed of held secrets and
key-shaped strings. No picture is taken while a person holds the browser (a
picture that overlapped a takeover is deleted), while a secret field shows its
value, on a page where the bot typed into a secret-looking field inside a frame
(a payment provider's card field) until the page moves on, for a minute after
`fill_login` typed a one-time code unless the page moves on, or while a dialog
blocks the page. Typing into a cross-origin frame records where it landed as
unknown. A capture waits 12 s.

Hiding secrets is pattern-based and best effort. A picture is a screenshot of
the page, so it can show sensitive page content that no rule recognized, and
scrubbing text can miss a secret it was not told about. Treat the evidence store
as sensitive data: it stays on the server, is readable only through the
conversation's own routes, and is deleted with the conversation. Credentials
belong in a secure credential card or `fill_login`, never typed into a page or
chat for the bot to enter.

`server/browser-evidence.ts` stores them under
`<data dir>/evidence/<thread>/<generation>/` as `steps.jsonl` and
`step-NNNNNN.jpg` (folders 0700, files 0600). They are deleted with the
conversation and after 30 days. Pictures stop, while steps go on, at 200 MB per
conversation, at the smaller of 2 GB and a quarter of free space for all
conversations (the oldest other conversations' pictures go first), or under 1 GB
free. A picture that repeats the previous one is stored once. Steps stop at 50
MB of step lines per conversation. Limits are `EVIDENCE_LIMITS`. Routes, read
like the transcript:

- `GET /api/threads/:id/evidence`
- `GET /api/threads/:id/evidence/:generation/step-NNNNNN.jpg`
- `GET /api/threads/:id/evidence.tar` (an index plus the pictures)

An engine `ok` proves nothing for fill or type, because an invalid selector
"succeeds"; the step records where the typing actually landed.

## Process hygiene

A call waiting in the lane, its page reads, its recorded step and `fill_login`'s
typing all count as use, so an idle close never starts while the lane is held.
A preview frame holds off an idle close only while it is being taken and is not
use, so frames beside a turn never keep a browser open, and after a close a frame
finds no Chrome and starts none. An idle close forgets the session's relay port,
page-health cursors, element references and last picture, as a restart does.
The close and sweep rules are in
[Process hygiene](browser-packaging.md#process-hygiene).

## Tests

- Engine resolution, pinned download and install: `server/browser-engine.test.ts`.
- Relay, lane, page health, steps and evidence: `server/browser-relay.test.ts`,
  `server/browser-page-health.test.ts`, `server/browser-steps.test.ts`,
  `server/browser-evidence.test.ts`, `server/browser-page-size.test.ts`.
- Live view and takeover: `server/browser-live.test.ts`,
  `server/browser-live-routes.test.ts`, `server/browser-runtime.test.ts`.
- Tool argument shape: `server/browser-tool-shape.test.ts`.
- Against the real engine and Chrome: `scripts/testing/browser-evidence.e2e.test.ts`
  (`SEIRA_UI_E2E=1`) and `scripts/smoke-browser-bundle.mjs` for each packaged engine.
