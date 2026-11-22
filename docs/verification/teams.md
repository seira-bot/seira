# Departments and shared instructions

A department (the sidebar's bot group; `section` in the data and API) is a named membership group. It can be empty, and it
never limits which bots work together: every bot reaches every other bot, and a department only decides which Chief is in
charge ([Chief authority](team-access.md)). Group chats are
conversations, and Templates is the catalog that creates new teams and bots.
The sidebar and Team map use the same persisted team list. Existing bot and
group-chat labels migrate automatically; clearing a team's shared instructions
or moving its last bot does not remove the team.

Run the isolated lifecycle checks:

```sh
pnpm exec vitest run server/team-lifecycle.e2e.test.ts server/section-context.test.ts server/store.test.ts src/lib/team-map.test.ts --maxWorkers=2
SEIRA_UI_E2E=1 pnpm exec vitest run scripts/testing/team-lifecycle-ui.e2e.test.ts scripts/testing/team-template-ui.e2e.test.ts --maxWorkers=1
SEIRA_UI_E2E=1 pnpm exec vitest run scripts/testing/team-canvas-ui.e2e.test.ts --maxWorkers=1
```

The server test uses `launchVerificationServer`, sends a sample conversation,
creates an empty team, moves two existing bots, saves shared instructions,
renames the populated team, adds and removes members, then empties and renames
it again. It imports a legacy template with a colliding name and restarts the
exact disposable server. It checks retained instructions and conversation
messages, archived bots moving to General when their team is deleted, and
explicit empty-team deletion. API requests and `control-seira` wait/messages
results are kept beside the fixture log in `*.team-lifecycle.json`.

A second real process restart uses legacy bot and group records needing
migration beside a deliberately malformed team registry. Startup keeps both
conversations readable and persists their task migrations, logs a diagnostic,
and leaves the malformed file byte-for-byte unchanged. Later team and shared
instruction writes still fail closed until that file is repaired.

The renderer test uses `control-seira ui launch`, opens **Create department**, and checks
that renaming preserves the sidebar's collapsed state and ordering. It moves
two bots through Team map, edits membership, and creates a bot directly in the
team. Dismissing that pending creation must retain unsaved membership edits and
select the created bot when its response arrives. It edits shared instructions
and reloads. A second fixture client moves the bots out; live updates retain the
empty team. Rename preserves instructions; delete confirms that the team's
instructions will be removed. A delayed, failed deletion cannot be submitted
twice and remains retryable; confirmation focus stays contained and returns to
its trigger when dismissed. It captures
`.seira-scratch/verify-evidence/team-lifecycle.png` before deletion.
New lifecycle labels use the existing string catalog; untranslated packs fall
back to the English labels without changing or regenerating other translations.

The canvas renderer check uses that same isolated full-app launcher. It seeds
two Chiefs, two specialists with different model defaults, an empty team, and
a real conversation with the fake engine. Opening a bot's settings or model
section keeps Team map mounted. A multi-bot move preserves bot identities,
threads, model defaults, messages, and shared instructions; selecting a Chief
and another bot for a conflicting move leaves both memberships unchanged.
Team controls are grouped under each team's **Manage** menu.
The General-team move is also completed with keyboard input through the native
menu and bot picker, with focus returning to the menu summary afterward.
Cross-team drag/drop explains that the bot's home team and shared instructions
will change, and requires **Move bot** confirmation before writing through the
real API. Cancelling preserves membership and conversations. Same-team pointer
reordering and Alt + Up/Down change only personal card order; arranging a team
likewise stores its canvas position without changing membership. Both orders
and positions survive reload. Panning, zoom controls, and fitting teams to view
are checked against the rendered layout. Leaving a pending gesture permits the
next bot click, and Escape during arrangement restores the original position.
Idle cards omit the redundant Ready label. A computer shortcut appears only on
the selected bot and opens that bot's access settings while Team map remains
mounted.

The test retains its before/after receipts and dark/light screenshots beside
the fixture log as `*.team-canvas.json` and `*.team-canvas-*.png`. Its injected
pointer events exercise renderer gesture handlers against the isolated API;
they do not prove native pointer capture or physical mouse/touch behavior.
Native input and narrow-window appearance need separate fixture browser or
Electron verification. Never use the running desktop app for those checks.

The owner API keeps the existing `/api/sidebar-sections` name for older clients:

- `GET` returns `{ sections: string[] }`.
- `POST { name, botIds?: string[] }` creates a named team or moves the supplied
  bots into it. Omitted/empty `botIds` creates an empty team. An empty name with
  selected bots moves them into General. Chief conflicts change no memberships.
- `PUT ?section=NAME { addBotIds: string[], removeBotIds: string[] }` updates
  membership in an existing team. Removed bots move to General. Invalid or
  stale membership changes are rejected without partially applying the move.
- `PATCH ?section=NAME { name }` renames a team, including its bots, archived
  bots, group chats, shared instructions, management grants. It cannot merge into an existing team or rename during active work.
- `DELETE ?section=NAME` removes the team and its shared instructions while
  retaining bots, archived bots, group chats and their conversations in General.
  Finish active work first. Chief conflicts
  reject the deletion rather than changing leadership.

The registry shares the atomic section-context file so rename/delete cannot
split a team's name from its instructions. Team labels are remembered before a
bot write; a storage failure may leave an empty team, but cannot partially move
the selected bots. This does not change bot communication permissions.

Both fixtures own their fake engine, temporary home and data directory. Cleanup
stops only their own child processes. Never run these requests against the live
app or copy live data into a fixture.
