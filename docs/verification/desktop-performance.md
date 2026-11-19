# Desktop performance

`bench:desktop` measures the desktop app on isolated fixtures only. It uses a
temporary data folder, the fake engine and a headless Chrome with its own profile.
It prints one JSON object. Budgets turn that object into a pass or fail.

## What the bench measures

- `bundle`: first-load JavaScript and CSS of the production build.
- `server`: time from spawn to ready, memory, and timer work with no page open.
- `start`: page load to the sidebar and the last chat.
- `screens`: the main screens of the app.
- `idle`: CPU, timers, frames and React commits with nothing happening.
- `stream`: one long streamed reply, in components rendered per commit and long tasks.
- `big`: a seeded workspace with many bots, threads and one long conversation.
- `routines`: the routine history route and the bytes one run rewrites.

## Commands

```sh
pnpm bench:desktop --budgets scripts/bench-desktop-budgets.json
pnpm bench:desktop --only big --budgets scripts/bench-desktop-budgets.json
pnpm bench:desktop --budgets scripts/bench-desktop-budgets.json --budget-kinds count,memory
node --experimental-strip-types scripts/testing/bench-budgets.ts result.json
node --experimental-strip-types scripts/testing/bench-budgets.ts result.json --kinds count
```

The bench writes its JSON result first. Then it prints one line for each failed
budget and exits with code 1 if any budget failed. Use `--budget-kinds count,memory` on
a busy host. The standalone checker reads a result that `--out FILE` saved.
A budget for a phase that did not run is skipped. A budget for a phase that ran
and has no value fails.

## Budget kinds

| Kind | Meaning | Limit style |
|------|---------|-------------|
| `count` | Renders, mounts, DOM nodes, commits, bundle size | Strict. About 5 to 10 percent above the baseline. |
| `time` | Milliseconds and CPU percent | Red line. Far above the baseline, to catch a real regression. |
| `memory` | Resident memory in MB | Red line. Well above the baseline. |

A count does not change between runs, so a small increase is a real change.
A time changes with the load of the host, so its limit only catches large jumps.

## Host rule for time budgets

Run time budgets on an idle host. Run the bench serially. Do not run it next to builds,
tests or other benchmarks. On a busy host, check only `count` and `memory`.

## Change a budget

Change a limit in the same pull request as the change that moves the number.
Write the before and after numbers in the description of the pull request.
Tighten a limit when a fix lowers the number.

## 2026-11-19 observations

Linux x64, 8-core laptop CPU, Chromium, commit `3767b54db`. The host was under
load, so the times are noisy. The counts are stable.

| Measure | Value |
|---------|-------|
| Initial JavaScript | 4,201 KB raw, 1,369 KB gzip |
| Big workspace (150 bots, 300 threads, 2,000 messages): load to sidebar | 912 ms, 3,541 mounts |
| Switch back to the long conversation | 1,433 mounts, longest task 331 ms |
| Scroll, p95 frame | 21.7 ms |
| Stream, components per commit | 27.5 small, 74.3 big |
| Idle renderer CPU | 0.85% small, 1.3% big |
| Idle React commits in 20 s | 0 to 2 |
