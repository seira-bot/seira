# Stopping a Codex turn

A Codex turn runs in its own `codex app-server` child process. Every way that
process can end is listed here, with the test that guards it. The rule behind
the list: the runtime error `codex exited null (signal SIGTERM) before turn/completed`
must be unreachable from a steer, from a queued message, and from Stop. It stays
reachable only for a process something outside Seira killed (the out-of-memory
killer, a user's `kill -9`), which is the honest report.

Process kills go through `killCliTree` (`server/procs.ts`). The two SIGKILL
fallbacks (`server/drivers/codex-identity.ts` and the live-voice child in
`server/drivers/codex-live.ts`) act on a process that did not stop first.

## Which processes can be killed

| Process | Where | Trigger | Touches a running turn? |
| --- | --- | --- | --- |
| The turn's app-server | `terminate` in `server/drivers/codex.ts` | `stop`, `settle` and `relaunch`, below | Yes, this is the turn's own child. |
| Model catalog probe | `finish` in `server/drivers/codex-catalog.ts` | The catalog answered or the probe ended. | No, a separate process. |
| Sign-in identity probe | `finish` in `server/drivers/codex-identity.ts` | The probe answered or timed out (1 s). | No, a separate process. |
| Background text step | the `kill` passed to `server/drivers/codex-background-text.ts` | A one-shot `codex exec` (memory upkeep, skill review) ended. | No, a fresh process per step. |
| Live voice child | `terminate` in `server/drivers/codex-live.ts` | The voice session ended or was aborted. | No, a separate process. |

Only the first row is on a turn's path.

## Who ends a turn's process

| Path | When | Graceful first? |
| --- | --- | --- |
| `stop` | Any `interruptTurn`, `stopAll` or `dispose` of the adapter. | Yes: it sets `stopRequested` and aborts the turn's signal synchronously, sends `turn/interrupt`, waits up to a grace window (750 ms), and only then calls `terminate`. |
| `settle`, after the turn ended | Normal completion. The per-turn app-server never exits by itself. | No, it ends the idle process through `stop`. If that fails, an honest `codex did not shut down after termination was requested` error is raised, never the signal one; `keepStopping` retries while the turn still owns the thread. |
| `relaunch`, before the turn was acknowledged | The child exited or failed with a transient error before `turn/start` was acknowledged, and nothing had streamed. | The failed attempt is marked `abandoned` first, then ended. |
| Retry after a failed handshake | A transient error from `initialize` or the kickoff with nothing streamed (`state.sawStreamDelta === false`). | Same guard: `abandoned` first, then ended through `relaunch`. |

Everything that stops a bot's work reaches `stop` through the adapter's
`interruptTurn`: the Stop button, group and room cancel, the stall watchdog, the
room turn limit, routine cancel, a speaker cancelled in a room, and a typed
"stop". Engine changes and server shutdown reach it through `dispose` and
`stopAll`, which call `stop` for every active turn. Nothing outside the driver
calls `killCliTree` on a turn's child.

## How the process's exit is reported

The `close` handler of the child decides what an exit means, in this order:

1. `abandoned`: return without reporting. A retired retry attempt cannot report.
2. The turn already settled (`state.settled`): call `stop` and return. This is
   the quiet teardown after a normal ending.
3. `stopRequested`: settle the turn as `interrupted`, with no runtime error. An
   intentional Stop that ends in a kill is therefore quiet. The race is closed
   because `stop` sets `stopRequested` before its first `await`, so a `close`
   event cannot arrive between the flag and the interrupt.
4. Otherwise: report the exit honestly, with the signal when there is one. A
   signal exit is never retried.

## Why steer and queue cannot reach a kill

- `steerActiveTurn` in `server/drivers/codex.ts` sends one `turn/steer` request
  and returns `refused`, `indeterminate` or `steered`. It calls neither
  `terminate` nor `killCliTree`, and it refuses at once when the turn has
  settled, was abandoned or has a stop requested.
- `server/steer-queue.ts` calls no stop function. A refused steer puts the
  queue back (`restoreHeldSteeredQueue`) and the queue drains as a new turn
  after the running one completes, on a new process.
- The room queue-steer endpoint in `server/routes/channels.ts` follows the same
  contract: it lifts the queue (`holdChannelQueue`), calls `steer` on the engine
  that owns the running room turn, and restores or settles the held queue
  (`restoreHeldChannelQueue`, `settleHeldChannelQueueHead`). An engine that
  cannot steer keeps the queue.

The steer contract itself is in [Messages into a running turn](mid-turn-steering.md).

## Tests

`server/drivers/codex.test.ts`:

- `steers the running turn through turn/steer without killing the child`
- `reports an explicitly refused steer as refused so the caller queues, and keeps the child alive`
- `a refused steer queues, and the follow-up turn needs no mid-turn kill` (spies
  on `killCliTree` and checks both processes stay alive)
- `Stop interrupts through the protocol and reports no signal error`
- `escalates to a kill when the server ignores turn/interrupt, still without the signal error`
- `keeps ownership after an uncertain stop even when root close arrives`
- `does not announce a retry when Stop races a transient handshake failure`
- `an interrupt during the retry backoff settles the turn at once, not after the wait`

`server/steer-e2e.test.ts`, through the HTTP routes:

- `a codex message during a live turn is steered into it via turn/steer, and Stop never reports SIGTERM`
- `the queue steer endpoint pulls a codex queue into the running turn once the engine can steer`
- `an engine without live steering keeps its queue through the steer endpoint, then drains after Stop`
- `a room steer folds the queued head into the running codex turn, and room Stop reports no SIGTERM`
- `a room whose engine cannot steer keeps its queue, then drains after Stop`

A new path that ends a Codex child should go through `stop`, set `abandoned`
or `stopRequested` before the process can exit, and add a row to the tables
above with its test.
