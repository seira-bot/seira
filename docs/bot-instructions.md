# Bot instructions, setup by chat and profile history

How a bot's standing instructions (SOUL.md) are stored, changed, undone and
shown in settings. Tests and the code define the exact API details; this page is
the contract to keep when changing them.

## What the person gets

- Standing instructions of up to 24,000 UTF-8 bytes (`BOT_PROFILE_LIMITS.soul`),
  separate from the short description.
- Setup by conversation: `/setup` starts a bot interviewing the person and
  proposing its profile, working folder, skills, credentials and routines. A
  blank bot (no description and no instructions, `blankBot` in
  `server/setup-request.ts`) is offered the same start from its greeting.
- Change history for the profile, with an Undo for instructions.
- A read-only Overview, which the phone apps read from the same endpoint as the
  desktop.
- Skill import from GitHub, up to 30 skills per import
  (`MAX_SKILLS_PER_IMPORT` in `server/skill-fetch.ts`), with total request,
  size and time limits. Larger repositories are imported from a subfolder.

## One source of truth

The canonical instructions are `BotRecord.soul` in the bot store.
`<data dir>/bots/<id>/SOUL.md` is a readable mirror, not another database
(`server/bot-folder.ts`). The prompt always uses the canonical record, and
`soulSystemPrompt` renders the fenced block, which is empty for an empty soul.

- If the mirror is edited outside Seira, `readSoulDrift` reports drift. The bot
  keeps using the saved instructions until the person reviews the file in
  settings and chooses Apply or Discard. Both actions pin the displayed file and
  the profile revision, so a stale screen cannot overwrite a newer change.
- A missing mirror is recreated. A drifted mirror is never overwritten by reading
  settings or by an upgrade. An unreadable mirror shows an error in the editor
  and does not break turn dispatch (`checkSoulDrift`).
- A failed mirror write cannot change the instructions the model receives.
- Profile requests carry a durable id, so retrying an interrupted application
  does not apply the same change twice.

## Changes a bot asks for

`propose_profile` accepts name, title, description, soul, working folder, a
reason and an optional target bot. It is not a free profile-write tool: the
server (`server/profile-requests.ts`) derives the sender and conversation from
the turn's capability, and a sender id in the body is an assertion, not
authority.

- The change applies at once, with an Undo notice, at every access level
  (`server/direct-apply.ts`). The one exception is a Cloud home turn that its
  owner did not drive (a guest's, or one a webhook started); there the owner
  confirms on a card, which is validated again when answered because it can sit
  open for days.
- Undo (`undo` in the profile request service) works only for a change that
  applied on its own, and only while the profile is still at the revision the
  change produced. A profile that changed since refuses it with `UNDO_STALE`.
- A bot that targets another bot is checked by `validateTarget` at proposal and
  again at confirmation, so a Chief cannot reach a bot outside its own team
  section.
- Cards show before and after fields and a bounded line diff; a large change to
  the instructions shows the complete proposed text. Tool-returned display data
  is scrubbed of secrets like persisted messages are.
- The standing-instructions block in the prompt tells the bot that the person
  manages them in settings and that they rank below the person's current request
  and safety boundaries. It grants no authority: the services check the caller.
- This is an application boundary, not an operating-system sandbox. Provider
  approval rules and saved permissions still apply. Secrets belong in secure
  credential cards, never in ordinary chat.

## History and undo

`server/profile-versions.ts` appends one scrubbed row per changed field to
`history.ndjson` in the bot's folder (private modes). Instruction undo
(`POST /api/bots/:id/history/rollback`) takes the immutable row id and the
current profile revision, not a timestamp. A row whose earlier text had a secret
removed carries `canRestore: false` with a reason and cannot be restored
exactly. History does not archive plaintext credentials, is not an audit log of
every setting, and is not a substitute for execution receipts.

## Setup stays small

Setup is a prompt block plus the existing confirmation flows, not a workflow
engine (`server/setup-mode.ts`). A turn whose text starts with `/setup` expands
to a setup request and adds the block, which names only tools the selected
engine can call (for example it points to `skill_manage` only when skill
authoring is on). Scheduled work is proposed paused. OAuth sign-ins,
third-party developer apps and turning a routine on stay explicit actions of the
person. Configured bots keep their behavior; moving a long description into the
instructions happens only when the person chooses it.

## Settings that tell the truth

- Overview describes settings, routines, skills, connected apps and recent
  profile changes (`server/bot-overview.ts`). An inventory that could not be read
  says it could not be checked, not that nothing is connected.
- Prompt preview uses the same pure assembly helper as turns
  (`server/system-prompt.ts`). It is not the exact prompt of an active task:
  task folders, notes, recall, matched skills and the tools that actually mounted
  can change a dispatch, and token counts are approximate. Opening a preview does
  not provision a computer or start a model turn.
- Changing bots resets bot-scoped drafts and requests, and a stale response never
  fills another bot's editor or replaces a newer History read.

## Endpoints

- `GET /api/bots/:id/overview`: the summary for desktop and phones.
- `GET /api/bots/:id/system-prompt`: the settings preview.
- `GET /api/bots/:id/soul`: canonical text, revision, byte count, limit and drift.
- `POST /api/bots/:id/soul/apply-file` and `.../soul/discard-file`: guarded drift
  resolution.
- `GET /api/bots/:id/history` and `POST /api/bots/:id/history/rollback`.
- `POST /api/internal/profile-requests`: proposals, bound to the turn capability.

Do not add a general transaction framework or a shared card resolver because
several card types exist; extract the mechanics when a concrete repeated change
shows the need.

## Verifying

Follow [Bot settings](verification/bot-settings.md) against its isolated fixture,
never a live app or real user data. The unit tests are in
`server/bot-folder.test.ts`, `server/profile-requests.test.ts`,
`server/profile-versions.test.ts`, `server/bot-overview.test.ts`,
`server/setup-mode.test.ts` and `server/system-prompt.test.ts`. Renderer
behavior needs a check in a real browser or Electron window as well; a phone
build does not prove a flow on a physical device.
