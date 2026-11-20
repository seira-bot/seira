# Desktop startup timeline

The desktop app records the time of each startup phase. The bench opens the
packaged Linux app many times and reports the median of each phase.

## What the timeline records

Each time is in milliseconds since the main process started. The app records
each phase once, in this order:

1. `app-ready`
2. `splash-shown`
3. `credentials`
4. `config-migrated`
5. `proxy`
6. `server-fork`
7. `server-listening`
8. `server-healthy`
9. `window-created`
10. `entries-restored`
11. `window-loaded`
12. `root-rendered`
13. `window-shown`

The app writes one line that starts with `startup timeline` to `server.log`
when the main window is shown. The app does not change its behavior.

Set `OMB_STARTUP_TIMELINE` to an absolute path to get the same marks as JSON.
The app writes `{ "marks": { "<name>": <ms> } }` to that path once. The app
writes nothing when the value is empty or relative.

## Run the bench

Build the Linux package first. Then run:

```sh
node --experimental-strip-types scripts/bench-startup.ts --cold 5 --warm 5 --out startup.json
```

| Option | Meaning |
|--------|---------|
| `--executable PATH` | Packaged app. Default `release/linux-unpacked/openmausbot`. |
| `--cold N` | Opens with a new data folder each time. Default 5. |
| `--warm N` | Opens that reuse one data folder after one uncounted open. Default 5. |
| `--prime-hold-ms N` | Time that the uncounted open stays open after the window shows. Default 12000. The server writes its compile cache 10 s after it starts, so warm opens use that cache. |
| `--out FILE` | Write the JSON report to a file. |
| `--timeout-ms N` | Time limit for one open. Default 120000. |
| `--host-network` | Skip the private network. Stops if port 8799, 18799, or 28799 is in use. |
| `--keep` | Keep the temporary folders. |

The report has `cold` and `warm` sections with the runs and the median, minimum,
and maximum of each phase. A text table goes to stderr. The script exits with
code 1 when an open fails. It exits with code 2 on other platforms.

## Isolation

Each open uses a temporary `HOME` and temporary XDG folders. The app starts
with no inherited `OMB_` variable. The managed broker is off. The updates origin
is a closed loopback address. A private network namespace holds only the
loopback device, so the app never reaches the port of an installed app. The
bench starts `xvfb-run` when `DISPLAY` is not set.

## Read the numbers

Time numbers need a quiet host. Stop other builds and tests first. Record the
host load with each result.

## Observations

| Date | Commit | Host load | Cold median shown (ms) | Warm median shown (ms) |
|------|--------|-----------|------------------------|------------------------|
| 2026-11-19 | `a14167bb8` | load average 10–14, 16 CPUs | 5966 (5440–6366) | 2513 (2238–2735) |

The warm opens in the `a14167bb8` row did not use the server compile cache.

A/B of `f0e5a1281` (before) and `4a28b9ec3` (after: earlier finish beat, AppImage
compile cache, server fork without the splash wait). Both builds ran in the same
session, in turn, 2 rounds, load average 3–4, 16 CPUs. "AppImage" opens copy the
app to a new path at each open and set `APPIMAGE`. Median `window-shown` in ms,
with the range:

| Launch | Cold before | Cold after | Warm before | Warm after |
|--------|-------------|------------|-------------|------------|
| Plain | 4041 (3823–4295) | 3783 (3628–3824) | 1439 (1411–1671) | 1149 (1114–1224) |
| AppImage | 4128 (4095–4325) | 3797 (3664–4045) | 1757 (1653–1788) | 1262 (1172–1334) |
