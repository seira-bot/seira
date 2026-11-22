# One memory limit for all bot work on Linux

All bot work runs in one systemd user slice with a kernel memory limit
([memory for bots](../linux-desktop.md#memory-for-bots)). This recipe checks
the slice, a stop inside it, the notice, the Settings value, the watchdog
fallback, and the bot box inside a scope. It needs Linux with a systemd user
session. Run it on a host that you can load, not on a computer that someone
uses.

## Unit tests

```sh
pnpm exec vitest run server/memory-fence.test.ts server/bot-memory-budget.test.ts \
  server/bot-memory-cap.test.ts server/bot-memory-protection.test.ts server/engine-memory.test.ts \
  server/process-room.test.ts server/routes/config-bot-memory.test.ts server/procs.test.ts src/components/BotMemorySettings.test.ts
```

## A stop inside the slice

`SEIRA_BOT_MEMORY_FENCE=on` turns the slice on outside the desktop app. The
`memory` hold of the fake engine starts a program that takes 64 MB every
100 ms until `FAKE_CLAUDE_RELEASE` exists. `FAKE_CLAUDE_STEER_TEXTS` records
what reaches the engine while the turn runs.

```sh
export SEIRA_BOT_MEMORY_FENCE=on SEIRA_BOT_MEMORY_MAX_MB=1024
export FAKE_CLAUDE_TOOL_CALLS='[{"name":"Bash","input":{"command":"pnpm test"},"hold":"memory"}]'
export FAKE_CLAUDE_RELEASE=/tmp/fence/release FAKE_CLAUDE_STEER_TEXTS=/tmp/fence/steers.txt
node --experimental-strip-types scripts/control-seira.ts launch
```

From a second terminal, with the printed URL and data folder:

```sh
pnpm control:seira new-bot --name Probe --url http://127.0.0.1:PORT
pnpm control:seira send --bot BOT_ID --text "run all the tests" --url http://127.0.0.1:PORT
SLICE="seira_bots_$(printf %s "DATA_DIR" | sha256sum | cut -c1-10).slice"
CG=/sys/fs/cgroup$(systemctl --user show -p ControlGroup --value "$SLICE")
cat $CG/memory.max $CG/memory.swap.max $CG/cpu.max
grep oom_kill $CG/memory.events $CG/*.scope/memory.events
cat $CG/*.scope/cgroup.procs
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:PORT/api/health
touch /tmp/fence/release
pnpm control:seira wait --bot BOT_ID --timeout 40 --url http://127.0.0.1:PORT
pnpm control:seira messages --bot BOT_ID --limit 10 --url http://127.0.0.1:PORT
cat /tmp/fence/steers.txt
```

Expected:

- `memory.max` is `1073741824`, `memory.swap.max` is `0`, and `cpu.max` gives
  all CPUs but one. `nproc` in a scope of the slice prints that number.
- The engine process is in a `run-*.scope` under the slice.
- `oom_kill` goes to 1 in the slice and in the engine's scope within about one
  second. Health stays `200`, and the turn settles after the release.
- The messages hold the notice "A program in this task used all the memory set
  aside for bots on this computer (1 GB)…" once.
- `steers.txt` holds one line that names 1 GB and asks for fewer parallel
  workers.
- `GET /api/config` shows `botMemory.protection` `slice`, and the performance
  report says "Memory for all bots together: 1 GB, protection: slice".

## The Settings value

Launch again without `SEIRA_BOT_MEMORY_MAX_MB`, then:

```sh
curl -s -X PUT -H 'content-type: application/json' -H 'origin: http://127.0.0.1:PORT' \
  -d '{"botMemoryGb":0.5}' http://127.0.0.1:PORT/api/config
curl -s -X PUT -H 'content-type: application/json' -H 'origin: http://127.0.0.1:PORT' \
  -d '{"botMemoryGb":2}' http://127.0.0.1:PORT/api/config
```

The first answers 400 with "Enter a number of GB from 1 to …". After the second,
start a turn: the slice's `memory.max` is `2147483648`. Each data folder gets a
slice of its own name.

## The watchdog fallback

Launch with `SEIRA_BOT_MEMORY_FENCE=on SEIRA_BOT_MEMORY_MAX_MB=1024` and without
`XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`. The log says the kernel
memory limit is not available, `botMemory.protection` is `watchdog`, and the
performance report says "Memory for all bots together: 1 GB, protection:
watchdog".

## The bot box inside a scope

Launch with `SEIRA_VERIFY_BOT_BOX=1 FAKE_CLAUDE_VERSION=2.1.330` and the fence
switch. Limit a bot to one folder:

```sh
curl -s -X PATCH -H 'content-type: application/json' -H 'origin: http://127.0.0.1:PORT' \
  -d '{"folderAccess":{"limited":true,"folders":[{"path":"/tmp/fence/work","write":true}]}}' \
  http://127.0.0.1:PORT/api/bots/BOT_ID
```

A turn settles. The scope's `cgroup.procs` holds `bwrap`, the box bridge, and
the engine.

### Last exercised

2026-11-22, commit `ef12e2d5d`, on a Linux host with systemd and cgroup v2,
16 CPUs, with a 1024 MB budget. All four runs passed:

| Run | Result |
|-----|--------|
| Memory hog | One kill in the scope. Health stayed 200. One notice line, no "no room" line. The bot got the lower-load hint in the same turn. Slice: `memory.max` 1073741824, `memory.swap.max` 0, `cpu.max` 1500000 100000. |
| Settings | 0.5 GB was refused with the 1 to 8 GB range. 2 GB was accepted. The next engine got `memory.max` 2147483648 in a different slice. |
| No user manager | Protection was `watchdog` with the same 1 GB budget. |
| Bot box | `bwrap`, the box bridge, and the engine ran in one scope. The turn settled. |

No slice was left after the runs.
