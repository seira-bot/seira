# Messages into a running turn

Some words reach a bot while its turn is still running: a line the person types,
a note from another bot that handed the bot work, a teammate's answer to a
question the bot is waiting on, a loop-guard note. Where the engine can take
them, the server hands them to the running turn instead of starting another one
or stopping it. This page is the contract every driver follows, and what to do
to add the seam to a new one.

## The adapter contract

`Adapter.steer(threadId, text, images?)` (`server/contracts.ts`) delivers one
message into the turn that is running on `threadId`. A driver offers it only
when it declares `capabilities.queueing`. It answers one of three outcomes
(`SteerOutcome`):

| Outcome | Meaning | What the caller does |
| --- | --- | --- |
| `steered` | The engine took the words into the live turn. | Nothing is queued; the turn reads the words at its next step. |
| `refused` | The words were provably not delivered (no running turn, a closed pipe, an error answer from the engine, an image the engine cannot read). | Keeps the message queued; it runs as the next turn. |
| `indeterminate` | The words may have been delivered (a timeout, or a process that died after the write). | Treats it as delivered and never queues it again: running the same words twice is the one mistake this contract must not allow. |

`steer` never interrupts, kills or restarts anything to deliver words. A
message that the engine cannot take mid-turn simply waits for the turn to end.

## Who calls it

- A person's message to a busy bot (`server/routes/bot-messages.ts`) and the
  queue-steer endpoint in a room (`server/routes/channels.ts`), which lifts the
  room's queue, calls `steer` on the engine that owns the running turn, and puts
  the queue back when the outcome is `refused`.
- A bot's message to a teammate whose turn is running the work it handed on, or
  an answer to a question that work waits on (`server/host/question-routing.ts`).
  The words are wrapped in the sender's envelope, shown in the thread as the
  sender's own line, and the work's one result still comes back once.
- The loop guard's note to a turn that keeps failing (`server/host/loop-guard.ts`).
- A Codex async question answered from a card (`openAsyncQuestion` in
  `server/drivers/codex.ts`).

## What each driver does

| Driver | Seam | Outcomes |
| --- | --- | --- |
| Codex (`server/drivers/codex.ts`) | `turn/steer` request with `expectedTurnId`. | An error answer (the turn moved on, or is not steerable) is `refused`; a timeout after sending is `indeterminate`. |
| Claude Code (`server/drivers/claude.ts`) | A user message written to the CLI's stdin (`writeUser`) while the turn runs; the CLI folds it in before its next model call. | A missing or finished turn, an unreadable image or a failed write is `refused`. The process is never killed to steer. |
| Pi (`server/drivers/pi.ts`) | A `{type: "steer"}` RPC frame, answered with its own id. | The runtime's explicit refusal is `refused`; a death or timeout after the frame was written is `indeterminate`. |
| Muse Code (`server/drivers/muse-code.ts`) | `turn/steer` with the native turn id. | A protocol error is `refused`; any other failure is `indeterminate`. |
| API-model engines on the owned tool loop (`server/drivers/openai-chat.ts`) | `steer` parks the text on the running turn's entry (`asides`). The next round of the loop adds it to the request as a user message, so words land between rounds and never inside a tool batch. | `refused` only when no turn runs or it is ending. A turn that fails before reading a parked message says so in the chat. |
| ACP agents (`server/drivers/acp/`) | ACP has no steering method: the protocol's only mid-turn input is `session/cancel`, which aborts. An agent that advertises a steering slash command (`available_commands_update`) can take one as a second `session/prompt`; the driver then declares `queueing` and `steer` (`server/drivers/acp/steer.ts`). Hermes and custom ACP agents that set `steer: true` do this. | The agent's own answer line decides `refused` or accepted, and is kept out of the reply. A picture is always `refused`. A steer the agent reaches only after the turn's prompt was answered is `indeterminate`. |

An ACP agent that does not advertise the command stays queue-only: the message
waits and opens the next turn. A driver must not simulate a seam by cancelling
and re-prompting, or by sending frames the protocol does not define.

## Adding a seam to a new driver

1. Declare `capabilities.queueing` only when the engine accepts user input into
   the running turn. Never declare it to make a control appear in the interface.
   `steerImages` additionally requires `nativeImageInput` and means `steer`
   delivers `images` as structured input.
2. Implement all three outcomes. `refused` has to mean provably not delivered,
   or the caller will replay words that may already have run.
3. Deliver at a point the engine already honours between steps. Do not abort,
   kill or restart anything to inject words.
4. Test the three outcomes, that the engine's process stays alive after a
   steer, and that Stop after a steer settles quietly.

## Tests

- Codex: `steers the running turn through turn/steer without killing the child`,
  `reports an explicitly refused steer as refused so the caller queues` and
  `a steer that times out after delivery is indeterminate` in
  `server/drivers/codex.test.ts`.
- Claude Code: the steer tests in `server/drivers/claude.test.ts`
  (`a message sent mid-turn is steered into the running turn` and the
  continuation tests that follow it).
- Pi: `steers a running turn through the native steer frame and refuses once settled`
  and `correlates concurrent steers by frame id` in `server/drivers/pi.test.ts`.
- API-model loop: `delivers mid-turn asides into the next completion request after the tool round`
  and the other aside tests in `server/drivers/openai-chat.test.ts`.
- ACP: `server/drivers/acp/steer.test.ts` and `server/drivers/acp/hermes-steer.test.ts`.
- End to end through the HTTP routes, including rooms and engines that cannot
  steer: `server/steer-e2e.test.ts`.

How a Codex process is stopped, and why steering never reaches those paths, is
in [Stopping a Codex turn](codex-process-stop.md).
