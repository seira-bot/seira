# Bots changing app settings (`app_settings`)

Run the isolated recipe:

```sh
pnpm exec vitest run server/app-settings.e2e.test.ts
pnpm exec vitest run server/app-settings server/routes/app-settings.test.ts
pnpm exec tsc -p tsconfig.server.json --noEmit
```

The e2e test starts its own temporary server through `launchVerificationServer`
with the scripted Claude fixture. It creates one bot, stops that exact server,
puts the bot on Full access in its disposable `bots.json`, and starts it again
on the same temporary home. The scripted turns call `app_settings` through the
real injected agents MCP proxy, so every guard runs in the real server. The
fixture is a single-person desktop. The owner's Apply answer comes from a paired
admin session, as a paired phone's would. A second paired session has the
client scope only. Nothing touches live app data.

## What it checks

- **Safe.** A Full-access owner turn finds "turn timeout", sets
  `rooms.turnTimeoutMinutes` to 45 and gets an applied card with Undo.
  `config.json` and `GET /api/config` show 45. `POST /api/threads/:id/undo`
  sets back the earlier value, which is the default on a fresh install.
- **Waits for a tap.** Setting `providers.xai.url` posts a "Change xAI address?"
  card with Apply and Not now, and the consequence line that the saved key goes
  to the new host. Nothing changes before the answer. The card has no
  `autoApplied` flag. One `card-shown` row with rule `settings:keyTo` is
  logged. Apply from the admin session changes `config.json`, turns the card
  into an applied card with Undo, logs `user-approved`, and the bot hears the
  result in a resumed turn. Undo clears the address again.
- **Not now.** Declining a card leaves the value as it was, ends the card as
  declined, logs `user-denied`, and tells the bot. A second answer to the same
  card changes nothing.
- **Only the owner applies and undoes.** A session with the client scope only
  gets 403 when it answers Apply. The value stays and the card stays open. The
  same session gets 403 when it taps Undo on an applied settings card. The value
  stays, and an admin session can still undo it. A local request with no Origin
  header, or one from a browser while a bot works, gets 403 on Undo too.
- **A conversation someone else wrote into.** After a second paired device writes
  a line in the bot's thread, a safe setting (`rooms.turnTimeoutMinutes`) waits
  on a card with no consequence line. The card leaves out the current value. The
  owner opens both values through the review route (`POST
  /api/threads/:id/app-settings/:requestId/review`) with an admin session. A
  client-scope device gets 403. Apply applies it, and Undo restores it.
- **Secret.** `set keys.xaiApiKey` with a value is refused. Without a value it
  posts the secure key card. The key is in no tool result, message, decision
  row or saved config.
- **Owner-only.** `set vault.logins` is refused with one line saying where the
  person changes it.
- **A bot's own settings and a config value.** One turn renames the bot through
  `bots.name` and sets `profile.name`. Both apply at once through the real
  `PATCH /api/bots/:id` and `PUT /api/config`, and Undo puts each back.
- **Pictures.** One turn gives the bot a picture (`bots.picture`) and the person a
  photo (`profile.photo`) from a PNG in the bot's workspace. Each is copied into
  the attachment store and served at `/api/attachments/…`; the bot's crop turns
  from mascot to circle. A file named `.png` that is really an SVG is refused by
  its bytes, and a PNG in a folder outside the bot's own is refused by its real
  path. Undo brings back the mascot face and clears the photo. The containment,
  link, attachment-store, size and type checks are in
  `server/app-settings/picture-file.test.ts`.
- **Approval mode.** The Full-access bot puts itself on Ask; the bot and every
  thread move to Ask at once, and Undo puts the bot and each conversation back on
  the mode it had. A conversation that sat on Ask before the change stays on Ask
  after Undo. Raising the mode from Ask to Full waits on a card that says the bot
  will do more without asking, and logs rule `settings:autonomyUp`. Apply puts the
  bot on Full access. The same mode waits too when one conversation sits below it.
  Apply and Undo are refused when any conversation changed after the card or the
  change. A bot cannot name conversations in its own request. A bot with a
  conversation on Custom approval is refused. Undo checks each conversation as
  Settings does, before it writes any of them.
- **The whole text.** A rule for every bot, the about-you text, the new-bot
  template and a bot's instructions wait on a card that holds the complete old and
  new text, not a shortened one. The desktop card scrolls long text. Clearing a
  text that is not empty waits. Clearing a text that is already empty changes
  nothing.
- **More access waits.** Turning the built-in browser, connected apps or a tool
  group back on waits on a card that says what the bot can then do. The
  installation-wide built-in browser switch waits when it goes from off to on, and
  does not wait when it is already on. The local-network switch waits when it goes
  from off to on. So does moving
  a browser profile to the person's own Chrome. Turning each one off applies at
  once.
- **Image generation.** `get ai.images` returns the models of each provider and
  whether each provider is ready, and holds no key. `set ai.images` with a model
  that its provider does not have is refused, and the answer lists the valid
  models.
- **Window preferences.** A skin change is refused while no app window's live
  stream (`/api/events?window=1`) is open, applied once one connects, refused
  after it closes, and applied again on reconnect.
- **AI engines.** An OpenAI-compatible add with a key in the value is refused;
  with `keyFrom` naming the saved OpenRouter key it waits on a card that names
  the host that receives the key. No engine exists before Apply; after Apply the
  engine has that key. `get` lists it with no key. Removing it is refused with
  one line saying the person does that in Settings → AI, and Undo on the add
  removes it. The key is in no tool result, message or decision row.
- **Not the owner's turn.** A webhook's run can `get` a setting, but its `set`
  is refused with the automation line and the setting stays as it was.

## Limits

The scripted engine stands in for the model. This recipe does not show whether
a real model follows the tool's instructions. It checks server and proxy
behaviour, not the rendered cards or how phones draw them. The desktop-bridge
preferences (remote access, open at login, window frame, sidebar colour, talk
shortcut, product emails) are covered only by `src/lib/window-prefs.test.ts`
with a stubbed bridge, not a packaged desktop app. Undo of the per-bot,
browser-profile and library-skill settings, turning a way in on but not off,
and the owner-only list, the 15-minute expiry, a value that changed after the card, a
card that a restart left open, an undo file with no key in it, the three-card limit and
the refusals for a Cloud guest, a shared server and a Team Cloud are covered by the unit
tests in `server/app-settings/host.test.ts`. The fixture's engine reports no tool
activity lines, so the secret check reads the thread as the fixture writes it.
