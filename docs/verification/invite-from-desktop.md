# Inviting a person from the desktop window

This check opens the real app shell in three Electron windows. Each window uses
one disposable fake-engine server with email sign-in on. Nothing touches live
app data and no mail leaves the machine.

Run it on a machine with a screen, or under a virtual one:

```sh
xvfb-run -a -s "-screen 0 1600x1000x24" node --experimental-strip-types scripts/verify-invite-from-desktop.mjs
```

The first run builds the page, which takes a few minutes. Set
`SEIRA_INVITE_UI` to a folder to keep the built page and skip the build on
later runs. Set `SEIRA_INVITE_SHOTS` to a folder to keep the screenshots. When
Electron runs under a sandbox that blocks its own, set
`SEIRA_ELECTRON_NO_SANDBOX=1`.

## What it checks

The server starts with one admin and one department, Sales.

- **Server window.** The window is the desktop app showing a connected
  server's page. Settings shows People. The Members block shows the Invite
  button. Invite opens the dialog. Saving `guest@corp.test` shows "Invite
  ready" with a copy control, and the new row is in the list. The Sales menu
  has "Invite to this department".
- **This computer's window.** The window is the desktop app showing its own
  computer. Settings has no People. The Sales menu has no invite entry.
- **Browser page.** The same page with no desktop bridge. People and Invite
  work as in the server window.
- The run blocks every address except the server's own, and fails if the app
  asks for another one. Only a favicon request to a search site is ignored.

Each step saves a PNG: `remote-*`, `local-*` and `browser-*`. The menu is closed or
fading in the `*-department-menu.png` files. The check reads the menu's text while it
is open, so trust the text check and not that picture.

## What it does not prove

- A packaged desktop app. The windows load the built page through a test
  harness with stubs for the desktop bridge's answers.
- That a person receives or opens the invite link. No mail is sent.
- The wording of the dialog in other languages, or the layout on a phone.
- The server rules for who may invite. `server/app-settings-people.e2e.test.ts`
  and `src/components/settings/pages/PeoplePage.dom.test.ts` cover those.
