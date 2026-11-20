import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Workflow, WorkflowFrame, WorkflowStep } from "../../shared/workflows.ts";
import { RoutineManager, type RoutineRun } from "../routines.ts";
import { BUSY_MAX_MS, BUSY_POLL_MS, STEP_ATTEMPTS, createWorkflowRunner, workflowRunFrame, type StepTurn, type WorkflowRunState, type WorkflowRunner } from "./runner.ts";
import { workflowCopy } from "./routine-link.ts";
import { openWorkflowStore, type WorkflowStore } from "./store.ts";

const MINUTE = 60_000;
const at = { x: 0, y: 0 };
const names: Record<string, string> = { ana: "Ana", ben: "Ben" };
const botName = (id: string) => names[id];

const bot = (id: string, botId: string, instruction: string): WorkflowStep => ({ id, kind: "bot", botId, instruction, position: at });
const link = (from: string, to: string, branch?: "yes" | "no") => ({ id: `${from}-${to}`, from, to, ...(branch ? { branch } : {}) });
const flow = (steps: WorkflowStep[], connections: Workflow["connections"]): Workflow => ({ id: "w1", name: "Morning", createdAt: 1, updatedAt: 1, steps, connections });
const chain = () => flow(
  [bot("a", "ana", "Collect the news"), bot("b", "ben", "Write the digest"), { id: "p", kind: "post", position: at }],
  [link("a", "b"), link("b", "p")],
);

const dirs: string[] = [];
const stores: WorkflowStore[] = [];
const runners: WorkflowRunner[] = [];
afterEach(() => {
  for (const runner of runners.splice(0)) runner.close();
  for (const store of stores.splice(0)) try { store.close(); } catch { /* closed by the test */ }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function clock(start = Date.parse("2026-11-16T08:00:00Z")) {
  let now = start;
  const timers: Array<{ at: number; fire: () => void; off: boolean }> = [];
  return {
    now: () => now,
    setTimer(when: number, fire: () => void) {
      const timer = { at: when, fire, off: false };
      timers.push(timer);
      return () => { timer.off = true; };
    },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = timers.filter((timer) => !timer.off && timer.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.off = true;
        now = Math.max(now, due.at);
        due.fire();
      }
      now = target;
    },
  };
}

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "wfr-"));
  dirs.push(dir);
  const store = openWorkflowStore(dir);
  stores.push(store);
  const time = clock();
  const botStates: Record<string, "ready" | "busy" | "missing"> = { ana: "ready", ben: "ready" };
  const turns: StepTurn[] = [];
  const states: Array<[WorkflowRunState, string | undefined]> = [];
  const stopped: Array<[string, string]> = [];
  const posts: Array<{ stepId: string; text: string; written: () => void }> = [];
  const frames: WorkflowFrame[] = [];
  const routineRuns = new Map<string, RoutineRun>();
  const threads = { open: true };
  const routineRun = (id = "run-1", over: Partial<RoutineRun> = {}): RoutineRun => {
    const row = { id, routineId: "r-1", routineName: "Morning", botId: "ana", target: "bot", status: "running", manual: false, runOn: "seira", workflowId: "w1", threadId: "t-ana", ...over } as RoutineRun;
    routineRuns.set(id, row);
    return row;
  };
  const make = (): WorkflowRunner => {
    const runner = createWorkflowRunner({
      now: time.now,
      setTimer: time.setTimer,
      store,
      botName,
      botState: (botId) => botStates[botId] ?? "missing",
      threadFor: (_run, botId) => (threads.open ? `t-${botId}` : null),
      startTurn: (turn) => { turns.push(turn); },
      stopTurn: async (botId, threadId) => { stopped.push([botId, threadId]); },
      post: (_run, stepId, text, written) => { posts.push({ stepId, text, written }); },
      runState: (runId, state, detail) => { states.push([state, detail]); return routineRuns.get(runId) ?? null; },
      routineRun: (runId) => routineRuns.get(runId) ?? null,
      routines: () => [],
      runs: () => [...routineRuns.values()],
      emit: (frame) => frames.push(frame),
    });
    runners.push(runner);
    return runner;
  };
  const self = {
    store, time, botStates, turns, states, stopped, posts, frames, routineRuns, threads, routineRun,
    runner: make(),
    restart() { self.runner.close(); self.runner = make(); return self.runner; },
    async begin(workflow = chain(), id = "run-1") {
      store.putWorkflow(workflow);
      const errors: string[] = [];
      await self.runner.start(routineRun(id), "t-ana", (message) => errors.push(message));
      return errors;
    },
    run: (id = "run-1") => store.run(id)!,
    step: (stepId: string, id = "run-1") => store.run(id)!.stepRuns.find((candidate) => candidate.stepId === stepId),
    last: () => turns.at(-1)!,
    reply(text: string) { self.last().settle({ ok: true, text }); },
  };
  return self;
}

describe("a workflow run through its steps", () => {
  it("runs the bots one after another, hands each output on, posts the last one and completes", async () => {
    const r = rig();
    expect(await r.begin()).toEqual([]);
    expect(r.turns).toHaveLength(1);
    expect(r.last()).toMatchObject({ botId: "ana", threadId: "t-ana", stepId: "a", continuesRun: false });
    expect(r.last().prompt).toContain("Collect the news");
    expect(r.states.at(-1)).toEqual(["working", undefined]);

    r.reply("news");
    expect(r.last()).toMatchObject({ botId: "ben", threadId: "t-ben", stepId: "b", continuesRun: true });
    expect(r.last().prompt).toContain('<previous-step from="Ana">');
    expect(r.last().prompt).toContain("news");
    expect(r.run().threads).toEqual({ ana: "t-ana", ben: "t-ben" });

    r.reply("digest");
    expect(r.posts).toMatchObject([{ stepId: "p", text: "digest" }]);
    expect(r.run().status).toBe("active");
    r.posts[0]!.written();
    expect(r.run().status).toBe("completed");
    expect(r.states.at(-1)).toEqual(["completed", "digest"]);
    expect(r.run().stepRuns.map((step) => [step.stepId, step.status])).toEqual([["a", "done"], ["b", "done"], ["p", "done"]]);
  });

  it("sends each change to the screen, without the graph", async () => {
    const r = rig();
    await r.begin();
    r.reply("news");
    const frame = r.frames.at(-1)!;
    expect(frame.kind).toBe("workflow.run");
    expect(JSON.stringify(frame)).not.toContain('"graph"');
    expect(workflowRunFrame({ ...r.run(), stepRuns: [{ stepId: "a", status: "done", output: "x".repeat(20_000) }] }).run.stepRuns[0]).toMatchObject({ outputClipped: true });
  });

  it("refuses to start for a workflow that is gone, one that cannot run, and a run that already ended", async () => {
    const r = rig();
    const errors: string[] = [];
    await r.runner.start(r.routineRun("run-x"), "t-ana", (message) => errors.push(message));
    expect(errors).toEqual(["This routine's workflow is gone"]);
    r.store.putWorkflow(flow([{ id: "p", kind: "post", position: at }], []));
    await r.runner.start(r.routineRun("run-y"), "t-ana", (message) => errors.push(message));
    expect(errors[1]).toBe("A workflow starts with a bot step.");
    await r.begin();
    r.reply("news"); r.reply("digest"); r.posts[0]!.written();
    await r.runner.start(r.routineRun("run-1"), "t-ana", (message) => errors.push(message));
    expect(errors[2]).toBe("This workflow run already ended.");
  });

  it("fails a step whose bot is gone, or whose chat will not open, and marks the later steps not run", async () => {
    const r = rig();
    r.botStates.ben = "missing";
    await r.begin();
    r.reply("news");
    expect(r.step("b")).toMatchObject({ status: "failed", errorCode: "bot_missing", error: "Ben is no longer available." });
    expect(r.step("p")?.status).toBe("not_run");
    expect(r.run().status).toBe("failed");
    expect(r.states.at(-1)).toEqual(["failed", "Ben failed: Ben is no longer available."]);

    const q = rig();
    await q.begin();
    q.threads.open = false;
    q.reply("news");
    expect(q.step("b")).toMatchObject({ status: "failed", errorCode: "turn_failed", error: "Could not open a chat for Ben." });
    expect(q.turns).toHaveLength(1);
  });

  it("fails a step when its turn fails, or asks the person", async () => {
    const r = rig();
    await r.begin();
    r.reply("news");
    r.last().settle({ ok: false, error: "boom" });
    expect(r.step("b")).toMatchObject({ status: "failed", errorCode: "turn_failed", error: "boom" });
    expect(r.step("p")?.status).toBe("not_run");
    expect(r.run()).toMatchObject({ status: "failed", currentStepId: "b" });

    const q = rig();
    await q.begin();
    q.last().settle({ ok: false, error: "x", needsPerson: true });
    expect(q.step("a")).toMatchObject({ status: "failed", errorCode: "needs_person" });
    expect(q.step("a")?.error).toContain("Answer it in the chat, then run again from here.");
  });

  it("hides a secret in a step's output and error", async () => {
    const r = rig();
    await r.begin();
    r.reply("key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 end");
    expect(r.step("a")?.output).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });
});

describe("an AI check", () => {
  const branching = () => flow(
    [bot("a", "ana", "Collect"), { id: "c", kind: "check", question: "Is there news?", position: at }, bot("y", "ben", "Yes path"), bot("n", "ana", "No path")],
    [link("a", "c"), link("c", "y", "yes"), link("c", "n", "no")],
  );

  it("asks the bot of the last bot step, takes the yes branch and skips the other", async () => {
    const r = rig();
    await r.begin(branching());
    r.reply("news");
    expect(r.last()).toMatchObject({ botId: "ana", stepId: "c", continuesRun: true });
    expect(r.last().prompt).toContain("Is there news?");
    expect(r.last().prompt).toContain("news");
    r.reply("Yes.");
    expect(r.last()).toMatchObject({ botId: "ben", stepId: "y" });
    expect(r.last().prompt).toContain('<previous-step from="AI check">');
    expect(r.step("c")).toMatchObject({ status: "done", answer: "yes" });
    expect(r.step("n")?.status).toBe("skipped");
    r.reply("done");
    expect(r.run().status).toBe("completed");
    expect(r.step("n")?.status).toBe("skipped");
  });

  it("takes the no branch", async () => {
    const r = rig();
    await r.begin(branching());
    r.reply("news");
    r.reply("no");
    expect(r.last()).toMatchObject({ botId: "ana", stepId: "n" });
    expect(r.step("y")?.status).toBe("skipped");
    expect(r.step("c")?.answer).toBe("no");
  });

  it("completes the run when the chosen branch goes nowhere", async () => {
    const r = rig();
    await r.begin(flow([bot("a", "ana", "Collect"), { id: "c", kind: "check", question: "Ok?", position: at }, bot("y", "ben", "Yes")], [link("a", "c"), link("c", "y", "yes")]));
    r.reply("news");
    r.reply("no");
    expect(r.run().status).toBe("completed");
    expect(r.step("y")?.status).toBe("skipped");
    expect(r.states.at(-1)).toEqual(["completed", "news"]);
  });

  it("fails when the answer is not a clear yes or no", async () => {
    const r = rig();
    await r.begin(branching());
    r.reply("news");
    r.reply("perhaps, it depends");
    expect(r.step("c")).toMatchObject({ status: "failed", errorCode: "check_unclear" });
    expect(r.step("c")?.error).toContain("perhaps, it depends");
    expect(r.step("y")?.status).toBe("not_run");
    expect(r.run().status).toBe("failed");
  });
});

describe("a wait step", () => {
  const waiting = () => flow([bot("a", "ana", "Collect"), { id: "w", kind: "wait", minutes: 10, position: at }, bot("b", "ben", "Write")], [link("a", "w"), link("w", "b")]);

  it("waits for its minutes, then goes on with the output it received", async () => {
    const r = rig();
    await r.begin(waiting());
    r.reply("news");
    expect(r.step("w")).toMatchObject({ status: "waiting", waitingFor: "time", output: "news" });
    expect(r.states.at(-1)![0]).toBe("waiting");
    r.time.advance(10 * MINUTE - 1);
    expect(r.turns).toHaveLength(1);
    r.time.advance(1);
    expect(r.last()).toMatchObject({ botId: "ben", stepId: "b" });
    expect(r.last().prompt).toContain("news");
    expect(r.step("w")?.status).toBe("done");
  });

  it("keeps its time across a restart, and a second recover does not arm it twice", async () => {
    const r = rig();
    await r.begin(waiting());
    r.reply("news");
    r.time.advance(4 * MINUTE);
    r.restart();
    r.runner.recover();
    r.runner.recover();
    r.time.advance(6 * MINUTE - 1);
    expect(r.turns).toHaveLength(1);
    r.time.advance(1);
    expect(r.turns).toHaveLength(2);
    expect(r.last().stepId).toBe("b");
  });

  it("goes on at once when the wait ended while Seira was off", async () => {
    const r = rig();
    await r.begin(waiting());
    r.reply("news");
    r.runner.close();
    r.time.advance(30 * MINUTE);
    r.restart();
    r.runner.recover();
    r.time.advance(0);
    expect(r.turns).toHaveLength(2);
  });
});

describe("a bot that is busy", () => {
  it("waits for it, looks again every 30 seconds, and starts when it is free", async () => {
    const r = rig();
    await r.begin();
    r.botStates.ben = "busy";
    r.reply("news");
    expect(r.turns).toHaveLength(1);
    expect(r.step("b")).toMatchObject({ status: "waiting", waitingFor: "bot" });
    expect(r.states.at(-1)).toEqual(["waiting", "Waiting for Ben to finish other work"]);
    r.time.advance(BUSY_POLL_MS);
    expect(r.turns).toHaveLength(1);
    r.botStates.ben = "ready";
    r.time.advance(BUSY_POLL_MS);
    expect(r.last()).toMatchObject({ botId: "ben", stepId: "b" });
    expect(r.step("b")).toMatchObject({ status: "running", attempts: 1 });
  });

  it("fails after three hours", async () => {
    const r = rig();
    await r.begin();
    r.botStates.ben = "busy";
    r.reply("news");
    for (let waited = 0; waited <= BUSY_MAX_MS + BUSY_POLL_MS; waited += BUSY_POLL_MS) r.time.advance(BUSY_POLL_MS);
    expect(r.step("b")).toMatchObject({ status: "failed", errorCode: "bot_busy_too_long", error: "Ben stayed busy for 3 hours." });
  });

  it("does not count a busy bounce of a turn as an attempt", async () => {
    const r = rig();
    await r.begin();
    r.last().settle({ ok: false, busy: true, error: "The chat is busy" });
    expect(r.step("a")).toMatchObject({ status: "waiting", waitingFor: "bot", attempts: 0 });
    r.time.advance(BUSY_POLL_MS);
    expect(r.turns).toHaveLength(2);
    expect(r.step("a")?.attempts).toBe(1);
  });
});

describe("a person's answer inside a step", () => {
  it("waits for the person while a question is open, and goes on when it is answered", async () => {
    const r = rig();
    await r.begin();
    r.runner.asked("t-ana", "Which account?");
    expect(r.step("a")).toMatchObject({ status: "waiting", waitingFor: "person" });
    expect(r.states.at(-1)).toEqual(["waiting", "Which account?"]);
    r.runner.asked("t-ana", null);
    expect(r.step("a")).toMatchObject({ status: "running" });
    expect(r.states.at(-1)).toEqual(["working", undefined]);
    r.reply("news");
    expect(r.last().stepId).toBe("b");
  });

  it("ignores a question in a chat that runs no step", async () => {
    const r = rig();
    await r.begin();
    r.runner.asked("t-other", "Which?");
    expect(r.step("a")?.status).toBe("running");
  });
});

describe("a restart in the middle of a step", () => {
  it("runs the step again once, and tells the bot", async () => {
    const r = rig();
    await r.begin();
    r.restart();
    r.runner.recover();
    expect(r.turns).toHaveLength(2);
    expect(r.last().prompt).toContain("Seira restarted while this step was running.");
    expect(r.step("a")?.attempts).toBe(2);
  });

  it("fails the step when it was cut a second time", async () => {
    const r = rig();
    await r.begin();
    for (let n = 1; n < STEP_ATTEMPTS; n++) { r.restart(); r.runner.recover(); }
    r.restart();
    r.runner.recover();
    expect(r.step("a")).toMatchObject({ status: "failed", errorCode: "restart_cut" });
    expect(r.run().status).toBe("failed");
  });

  it("goes on from a step that was done, and starts the post step again", async () => {
    const r = rig();
    await r.begin();
    r.reply("news");
    r.restart();
    r.runner.recover();
    expect(r.turns).toHaveLength(3);
    r.reply("digest");
    r.restart();
    r.runner.recover();
    expect(r.posts).toHaveLength(2);
  });

  it("ends a run whose routine run ended while Seira was off, and leaves a queued one", async () => {
    const r = rig();
    await r.begin();
    const row = r.routineRuns.get("run-1")!;
    Object.assign(row, { status: "queued" });
    r.restart();
    r.runner.recover();
    expect(r.run().status).toBe("active");
    Object.assign(row, { status: "cancelled", error: "Stopped" });
    r.runner.recover();
    expect(r.run().status).toBe("stopped");
    expect(r.step("a")).toMatchObject({ status: "failed", errorCode: "run_stopped", error: "Stopped" });
  });
});

describe("stopping a run", () => {
  it("stops the turn and marks the steps when the routine run is cancelled", async () => {
    const r = rig();
    await r.begin();
    const row = r.routineRuns.get("run-1")!;
    Object.assign(row, { status: "running" });
    r.runner.routineRunChanged(row);
    expect(r.run().status).toBe("active");
    Object.assign(row, { status: "cancelled", error: "Stopped by you" });
    r.runner.routineRunChanged(row);
    expect(r.run().status).toBe("stopped");
    expect(r.step("a")).toMatchObject({ status: "failed", errorCode: "run_stopped", error: "Stopped by you" });
    expect(r.step("b")?.status).toBe("not_run");
    expect(r.stopped).toEqual([["ana", "t-ana"]]);
    r.reply("late");
    expect(r.turns).toHaveLength(1);
    expect(r.run().status).toBe("stopped");
  });

  it("names the run limit", async () => {
    const r = rig();
    await r.begin();
    const row = r.routineRuns.get("run-1")!;
    Object.assign(row, { status: "failed", errorCode: "routines.server.overLimit", error: "Stopped: this run ran longer than the 12-hour limit" });
    r.runner.routineRunChanged(row);
    expect(r.run().status).toBe("failed");
    expect(r.step("a")?.errorCode).toBe("run_limit");
  });

  it("drops a wait's timer", async () => {
    const r = rig();
    await r.begin(flow([bot("a", "ana", "Collect"), { id: "w", kind: "wait", minutes: 5, position: at }, bot("b", "ben", "Write")], [link("a", "w"), link("w", "b")]));
    r.reply("news");
    const row = r.routineRuns.get("run-1")!;
    Object.assign(row, { status: "cancelled" });
    r.runner.routineRunChanged(row);
    r.time.advance(10 * MINUTE);
    expect(r.turns).toHaveLength(1);
  });

  it("ignores a routine run that is no workflow's", async () => {
    const r = rig();
    await r.begin();
    const plain = { ...r.routineRuns.get("run-1")!, status: "cancelled" } as RoutineRun;
    delete (plain as { workflowId?: string }).workflowId;
    r.runner.routineRunChanged(plain);
    expect(r.run().status).toBe("active");
  });
});

describe("running again from a step", () => {
  it("carries the finished steps over and starts at the chosen step with its input", async () => {
    const r = rig();
    await r.begin();
    r.reply("news");
    r.last().settle({ ok: false, error: "boom" });
    const old = r.run("run-1");
    const second = r.routineRun("run-2", { threadId: "t-new" });
    r.runner.prepareFrom(second, old, "b", chain());
    const prepared = r.run("run-2");
    expect(prepared).toMatchObject({ fromRunId: "run-1", startStepId: "b", status: "active", input: { fromStepId: "a", output: "news" } });
    expect(prepared.stepRuns).toMatchObject([{ stepId: "a", status: "done", carried: true, output: "news" }]);

    await r.runner.start(second, "t-new", () => {});
    expect(r.last()).toMatchObject({ botId: "ben", stepId: "b", threadId: "t-ben" });
    expect(r.last().prompt).toContain("news");
    expect(r.run("run-2").threads).toMatchObject({ ana: "t-new", ben: "t-ben" });
    r.reply("digest");
    r.posts.at(-1)!.written();
    expect(r.run("run-2").status).toBe("completed");
    expect(r.step("a", "run-2")).toMatchObject({ carried: true, status: "done" });
  });

  it("refuses a step that the workflow no longer has", async () => {
    const r = rig();
    await r.begin();
    expect(() => r.runner.prepareFrom(r.routineRun("run-2"), r.run(), "gone", chain())).toThrow("That step is no longer in the workflow.");
    expect(r.store.run("run-2")).toBeNull();
  });
});

describe("the run limit of a routine run", () => {
  const kept = () => {
    const time = clock(Date.parse("2026-11-16T08:00:00Z"));
    const dir = mkdtempSync(join(tmpdir(), "wfr-"));
    dirs.push(dir);
    const store = openWorkflowStore(dir);
    stores.push(store);
    const turns: StepTurn[] = [];
    const stopped: string[] = [];
    const workflow = flow([bot("a", "ana", "Collect"), { id: "w", kind: "wait", minutes: 1_000, position: at }, bot("b", "ana", "Write")], [link("a", "w"), link("w", "b")]);
    store.putWorkflow(workflow);
    let manager!: RoutineManager;
    const runner = createWorkflowRunner({
      now: time.now, setTimer: time.setTimer, store, botName, botState: () => "ready",
      threadFor: (_run, botId) => `t-${botId}`,
      startTurn: (turn) => { turns.push(turn); },
      stopTurn: async (_botId, threadId) => { stopped.push(threadId); },
      post: (_run, _stepId, _text, written) => written(),
      runState: (runId, state, detail) => manager.workflowRunState(runId, state, detail),
      routineRun: (runId) => manager.listRuns().find((candidate) => candidate.id === runId) ?? null,
      routines: () => manager.listRoutines(),
      runs: () => manager.listRuns(),
      emit: () => {},
    });
    runners.push(runner);
    const dataDir = mkdtempSync(join(tmpdir(), "wfr-"));
    dirs.push(dataDir);
    manager = new RoutineManager({
      file: join(dataDir, "routines.json"),
      now: time.now,
      emit: () => {},
      botState: () => "ready",
      goalState: () => "missing",
      createTask: () => ({ threadId: "t-ana" }),
      createGoalTask: () => ({ threadId: "unused" }),
      startTurn: async () => { throw new Error("a workflow run never starts a plain bot turn"); },
      interruptTurn: async () => {},
      onRunChanged: (run) => runner.routineRunChanged(run),
      workflowCopy: (id) => (id === "w1" ? workflowCopy(workflow, botName) : null),
      startWorkflow: (run, threadId, onDispatchError) => runner.start(run, threadId, onDispatchError),
    });
    const routine = manager.create({ name: "Morning", workflowId: "w1", prompt: "x", botId: "ana", schedule: { type: "interval", everyMinutes: 24 * 60, anchorAt: time.now() + 7 * 24 * 60 * MINUTE } });
    const started = manager.runNow(routine.id)!;
    return { time, store, turns, stopped, manager, started, minute: async (count: number, every = MINUTE) => { for (let n = 0; n < count; n++) { time.advance(every); await manager.tick(); } } };
  };

  it("stops a step that works for twelve hours, and stops its turn", async () => {
    const k = kept();
    await k.manager.tick();
    expect(k.turns).toHaveLength(1);
    await k.minute(715);
    expect(k.manager.listRuns().find((run) => run.id === k.started.id)?.status).toBe("running");
    await k.minute(10);
    const row = k.manager.listRuns().find((run) => run.id === k.started.id)!;
    expect(row).toMatchObject({ status: "failed", errorCode: "routines.server.overLimit" });
    expect(k.store.run(k.started.id)).toMatchObject({ status: "failed" });
    expect(k.store.run(k.started.id)!.stepRuns.find((step) => step.stepId === "a")).toMatchObject({ status: "failed", errorCode: "run_limit" });
    expect(k.stopped).toContain("t-ana");
  });

  it("does not count the time of a wait", async () => {
    const k = kept();
    await k.manager.tick();
    k.turns[0]!.settle({ ok: true, text: "news" });
    expect(k.manager.listRuns().find((run) => run.id === k.started.id)).toMatchObject({ status: "waiting" });
    await k.minute(40, 30 * MINUTE);
    expect(k.turns).toHaveLength(2);
    expect(k.manager.listRuns().find((run) => run.id === k.started.id)?.status).toBe("running");
    k.turns[1]!.settle({ ok: true, text: "digest" });
    const row = k.manager.listRuns().find((run) => run.id === k.started.id)!;
    expect(row.status).toBe("completed");
    expect(row.workedMs ?? 0).toBeLessThan(60 * MINUTE);
    expect(k.store.run(k.started.id)!.status).toBe("completed");
  });
});

describe("a turn that keeps bouncing off a busy chat", () => {
  it("fails after three hours, because the busy clock keeps running between starts", async () => {
    const r = rig();
    await r.begin();
    for (let waited = 0; waited <= BUSY_MAX_MS + 2 * BUSY_POLL_MS && r.run().status === "active"; waited += BUSY_POLL_MS) {
      if (r.step("a")?.status === "running") r.last().settle({ ok: false, busy: true, error: "The chat is busy" });
      r.time.advance(BUSY_POLL_MS);
    }
    expect(r.step("a")).toMatchObject({ status: "failed", errorCode: "bot_busy_too_long" });
    expect(r.run().status).toBe("failed");
  });

  it("starts the busy clock again for the next step after a turn really ran", async () => {
    const r = rig();
    await r.begin();
    r.last().settle({ ok: false, busy: true, error: "The chat is busy" });
    r.time.advance(BUSY_POLL_MS);
    expect(r.step("a")?.busySince).toBeDefined();
    r.reply("news");
    expect(r.step("a")?.busySince).toBeUndefined();
  });
});

describe("what a waiting run says", () => {
  it("names a time wait without a clock time", async () => {
    const r = rig();
    await r.begin(flow([bot("a", "ana", "Collect"), { id: "w", kind: "wait", minutes: 10, position: at }, bot("b", "ben", "Write")], [link("a", "w"), link("w", "b")]));
    r.reply("news");
    expect(r.states.at(-1)).toEqual(["waiting", "Waiting for the planned time"]);
    expect(r.states.at(-1)![1]).not.toMatch(/\d{4}-\d\d-\d\d|T\d\d:/);
  });
});

describe("a step of a kind this version does not know", () => {
  it("fails the step with a reason instead of completing the run", async () => {
    const r = rig();
    await r.begin(flow([bot("a", "ana", "Collect"), { id: "x", kind: "future", position: at } as unknown as WorkflowStep], [link("a", "x")]));
    r.reply("news");
    expect(r.run().status).toBe("failed");
    expect(r.step("x")).toMatchObject({ status: "failed", errorCode: "turn_failed" });
    expect(r.step("x")?.error).toContain("newer version");
  });
});
