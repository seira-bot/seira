# Crash reports

When Seira stops working, the desktop app can send one small report to Seira's
crash report service. The report helps the maintainers find and fix the fault.

A report never contains your messages, files, or names. This page lists every
field of a report. Nothing else is sent.

## The switch

The switch is **Send crash reports**. It is in Settings → General → Privacy.

- The switch is on after you install Seira and after an update.
- Seira asks no question about it and shows no dialog.
- Turn it off and Seira sends nothing. Seira also deletes every report that
  waits to be sent.
- A crash that happens while the switch is off is never sent, also not after
  you turn the switch on again.
- It is a different switch from usage analytics. Each switch works alone.

## What a report contains

| Field | What it is |
|-------|------------|
| Event id | A random id of 32 characters. It is the id of this one report. |
| Release | The app version, for example `seira@0.1.188`. |
| Environment | The name of the build channel, for example `production`. |
| Tags | The kind of failure, the part of the app that failed (main, window, graphics, helper, server), the package type, and a session id. When they apply: the reason, the exit code, the engine type, and the page name. |
| System | The name and version of the operating system. |
| App | The app version. |
| Runtime | The name and version of the runtime that Seira uses. |
| Exception type | The error name, for example `TypeError`. |
| Message | The error message, only when the two rules below are true. Otherwise the report has the error type and no message. |
| Stack frames | At most 30 frames. Each frame has a function name and a place in the Seira code. Code that is not from Seira has no function name. |
| Breadcrumbs | At most 20 short notes from a fixed list: the app started, the page changed, a process changed state. |

The report has an error message only when both rules are true:

- The error type is a built-in JavaScript type: `TypeError`, `RangeError`,
  `ReferenceError`, `SyntaxError`, `URIError`, or `EvalError`.
- The message passes a filter. It has at most 200 characters. It has no path,
  no address, no `@`, no long number, no dotted name, no quoted value, no two
  capitalized words in a row, and no user name or computer name.

For every other error type, and for every crash, hang, and server exit, a
report has the error type and no message.

Some terms in the table:

- The **session id** is a random value. Seira makes a new one each time the app
  starts and does not save it. It does not link two app starts.
- The **page name** is one of: chat, settings, onboarding, rail, other.
- The **engine type** is one of the engines that Seira knows, or `custom`.
- **Stack frames** point to Seira code. The service turns them into readable
  function names with source maps, which Seira uploads when it makes a release.
  Seira packages contain no source maps.

## What a report never contains

- Message text, prompts, or the contents of a file.
- File names, file paths, folder names, or web addresses.
- The name of a bot, a room, a thread, or a person.
- Your email address, phone number, or any key, token, or password.
- The name of your computer or your operating system user name.
- A stable id of your install, your device, or your account.
- A memory dump (minidump) or any part of the memory of a process.
- Your IP address. The report service removes it before it keeps or forwards a
  report. It keeps a keyed hash of the address for at most one hour, only to
  limit how many reports one network can send.

When the app crashes in its native code (a window process, the graphics
process, or the main process), the report has only the process type, the
reason, and the exit code.

## When Seira sends nothing

- The switch is off.
- The server runs without the desktop app: Docker, `seira serve`, a VPS, an npm
  install, and Seira Cloud. These servers have no switch and send no report.
- The build has no crash report service. A fork, a local build, and a
  development build have none, and they do not show the switch.
- Seira sent 10 reports in the last hour. It waits until the oldest one is an
  hour old.
- Seira already sent a report for the same fault since the app started.

If Seira cannot reach the service, it keeps the report on your disk. It sends
the report at the next app start or when the network is back, if the switch is
on. The queue holds at most 30 reports and 10 MB. The oldest report goes first
when the queue is full.

## How long reports stay

The service provider keeps a report for 90 days at most. The crash report
service does not keep your IP address.

## See the reports that Seira sent

Each report has an id. Seira writes the id and the kind of failure, and no
message text, to `desktop-crashes.log` in the app's data folder.

When you send a bug report from Seira, the diagnostics report lists the ids of
the crash reports that Seira sent in the last 7 days. You find them in
Settings → This app → Help, in the diagnostics report, in the section
**Crash report ids**. A maintainer can use an id to find the matching report.
