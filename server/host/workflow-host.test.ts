import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RoutineAccess } from "../../shared/routines.ts";
import type { WorkflowFrame, WorkflowInput, WorkflowStep } from "../../shared/workflows.ts";
import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import type { HostTurnResult } from "../coordinator.ts";
import { createReadAndDraft } from "../read-and-draft.ts";
import { bindThread, runOfThread } from "../routine-step-threads.ts";
import type { Routine, RoutineRun } from "../routines.ts";
import { Store } from "../store.ts";
import { createWorkflowHost, type WorkflowHost, type WorkflowHostDeps, type WorkflowRoomTurn, type WorkflowTurnOptions } from "./workflow-host.ts";

const at = { x: 0, y: 0 };
const bot = (id: string, botId: string, instruction: string): WorkflowStep => ({ id, kind: "bot", botId, instruction, position: at });
const input = (): WorkflowInput => ({
  name: "Morning",
  steps: [bot("a", "ana", "Collect the news"), bot("b", "ben", "Write the digest"), { id: "p", kind: "post", position: at }],
  connections: [{ id: "1", from: "a", to: "b" }, { id: "2", from: "b", to: "p" }],
});
const noPost = (): WorkflowInput => ({ ...input(), steps: input().steps.slice(0, 2), connections: input().connections.slice(0, 1) });

const dirs: string[] = [];
const hosts: WorkflowHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) try { host.close(); } catch { /* closed by the test */ }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

function rig(over: Partial<WorkflowHostDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wfh-"));
  dirs.push(dir);
  let now = Date.parse("2026-11-16T08:00:00Z");
  const frames: WorkflowFrame[] = [];
  const turns: Array<{ botId: string; text: string; opts: WorkflowTurnOptions }> = [];
  const patched: unknown[][] = [];
  const created: unknown[][] = [];
  const updates: Array<[string, unknown]> = [];
  const logs: string[] = [];
  const posts: Array<{ stepId: string; text: string }> = [];
  const cancelled: string[] = [];
  const states: Array<[string, string, string | undefined]> = [];
  const enqueued: unknown[] = [];
  const routineRows: Routine[] = [];
  const runRows: RoutineRun[] = [];
  const state = { startTurn: undefined as undefined | ((botId: string) => Promise<unknown>), failUpdate: false };
  const deps: WorkflowHostDeps = {
    dataDir: dir,
    store: { bot: (id: string) => ({ name: ({ ana: "Ana", ben: "Ben" } as Record<string, string>)[id] }) as never, patchTask: ((...args: unknown[]) => { patched.push(args); }) as never, taskByThread: (() => null) as never, projectBotForTask: (() => null) as never },
    routines: () => ({
      listRoutines: () => routineRows,
      listRuns: () => runRows,
      runNow: () => runRows[0] ?? null,
      enqueueWebhook: ((input: unknown) => { enqueued.push(input); return { id: "run-2" }; }) as never,
      cancelRun: async (id: string) => { cancelled.push(id); return null; },
      update: ((id: string, patch: unknown) => { if (state.failUpdate) throw new Error("nope"); updates.push([id, patch]); return null; }) as never,
      bindStepThread: (runId: string, threadId: string, access?: RoutineAccess) => { const row = runRows.find((candidate) => candidate.id === runId); if (row) bindThread(row, threadId, access); },
      runForThread: (threadId: string) => runOfThread(runRows, threadId),
      workflowRunState: ((runId: string, s: string, detail?: string) => { states.push([runId, s, detail]); return runRows.find((row) => row.id === runId) ?? null; }) as never,
    }),
    routineHooks: () => ({ createTask: ((...args: unknown[]) => { created.push(args); return { threadId: "t-new" }; }) as never, interruptTurn: async () => {} }),
    chatModel: (_botId, _run, modelSelection) => modelSelection,
    botState: () => "ready",
    startTurn: async (botId, text, opts) => { turns.push({ botId, text, opts }); return state.startTurn?.(botId); },
    reports: { postStep: ((_run: unknown, stepId: string, text: string, written: () => void) => { posts.push({ stepId, text }); written(); }) as never, runSettled: (() => {}) as never },
    emit: (frame) => frames.push(frame),
    now: () => now,
    log: (line) => logs.push(line),
    ...over,
  };
  const host = createWorkflowHost(deps);
  hosts.push(host);
  const run = (over: Partial<RoutineRun> = {}) => {
    const row = { id: "run-1", routineId: "r-1", routineName: "Morning", botId: "ana", target: "bot", status: "running", manual: false, runOn: "seira", workflowId: "", threadId: "t-ana", startedAt: now, ...over } as RoutineRun;
    runRows.splice(0, runRows.length, row);
    return row;
  };
  return { host, enqueued, frames, turns, patched, created, updates, logs, posts, cancelled, states, routineRows, runRows, run, state, tick: (ms: number) => { now += ms; } };
}

describe("the workflow host's workflows", () => {
  it("keeps who created a workflow apart from the workflow, and forgets it on delete", () => {
    const r = rig();
    const made = r.host.create(input(), "p_ada");
    const old = r.host.create(input());
    expect(r.host.creator(made.id)).toBe("p_ada");
    expect(r.host.creator(old.id)).toBeUndefined();
    expect(JSON.stringify(r.host.get(made.id))).not.toContain("p_ada");
    expect(JSON.stringify(r.frames)).not.toContain("p_ada");
    r.host.remove(made.id);
    expect(r.host.creator(made.id)).toBeUndefined();
  });

  it("creates, lists, updates and deletes a workflow, and tells the screen each time", () => {
    const r = rig();
    const made = r.host.create(input());
    expect(r.host.list()).toEqual([made]);
    expect(r.host.get(made.id)).toEqual(made);
    expect(r.frames.at(-1)).toEqual({ kind: "workflow", workflow: made });

    const changed = r.host.update(made.id, { ...input(), name: "Evening" })!;
    expect(changed).toMatchObject({ id: made.id, name: "Evening", createdAt: made.createdAt });
    expect(changed.updatedAt).toBeGreaterThan(made.updatedAt);
    expect(r.host.update("missing", input())).toBeNull();

    expect(r.host.remove(made.id)).toBe(true);
    expect(r.host.get(made.id)).toBeNull();
    expect(r.frames.at(-1)).toEqual({ kind: "workflow.deleted", workflowId: made.id });
    expect(r.host.remove(made.id)).toBe(false);
  });

  it("relinks the routines that use a workflow when it changes, and unlinks them before it is deleted", () => {
    const r = rig();
    const made = r.host.create(input());
    r.routineRows.push({ id: "r-1", workflowId: made.id } as Routine, { id: "r-2" } as Routine);
    r.host.update(made.id, input());
    expect(r.updates).toEqual([["r-1", { rewriteWorkflow: true }]]);
    r.host.remove(made.id);
    expect(r.updates.at(-1)).toEqual(["r-1", { workflowId: null, enabled: false }]);
  });

  it("turns a routine off when its workflow is deleted, and keeps the copy as its instruction", () => {
    const r = rig();
    const made = r.host.create(input());
    r.routineRows.push({ id: "r-1", workflowId: made.id, enabled: true, prompt: "copy" } as Routine);
    r.host.remove(made.id);
    expect(r.updates).toEqual([["r-1", { workflowId: null, enabled: false }]]);
  });

  it("rewrites a linked routine only when the copy, the bots or the first bot change", () => {
    const r = rig();
    const made = r.host.create(input());
    const copy = r.host.copyFor(made.id) as { prompt: string; botId: string; botIds: string[] };
    r.routineRows.push({ id: "r-1", workflowId: made.id, prompt: copy.prompt, botId: copy.botId, workflowBotIds: copy.botIds } as Routine);
    const moved = { ...input(), steps: input().steps.map((step) => ({ ...step, position: { x: 40, y: 40 } })) };
    r.host.update(made.id, moved);
    expect(r.updates).toEqual([]);
    r.host.update(made.id, { ...moved, steps: moved.steps.map((step) => (step.id === "a" ? { ...step, instruction: "Collect the weather" } as WorkflowStep : step)) });
    expect(r.updates).toEqual([["r-1", { rewriteWorkflow: true }]]);
  });

  it("logs a routine that cannot be updated, and goes on", () => {
    const r = rig();
    const made = r.host.create(input());
    r.routineRows.push({ id: "r-1", workflowId: made.id } as Routine);
    r.state.failUpdate = true;
    expect(() => r.host.update(made.id, input())).not.toThrow();
    expect(r.host.remove(made.id)).toBe(true);
    expect(r.logs[0]).toBe("workflows: could not update routine r-1: nope");
  });

  it("gives a routine the copy of a workflow that can run, a problem for one that cannot, and null for none", () => {
    const r = rig();
    const made = r.host.create(input());
    expect(r.host.copyFor(made.id)).toMatchObject({ workflowId: made.id, botId: "ana", botIds: ["ana", "ben"] });
    const empty = r.host.create({ name: "Empty", steps: [], connections: [] });
    expect(r.host.copyFor(empty.id)).toMatchObject({ code: "workflow_no_start" });
    expect(r.host.copyFor("missing")).toBeNull();
  });
});

describe("the workflow host's runs", () => {
  const begin = async (r: ReturnType<typeof rig>, body = input()) => {
    const made = r.host.create(body);
    const row = r.run({ workflowId: made.id });
    const errors: string[] = [];
    await r.host.start(row, "t-ana", (message) => errors.push(message));
    return { made, row, errors };
  };
  const settle = (r: ReturnType<typeof rig>, outcome: Partial<HostTurnResult>) => r.turns.at(-1)!.opts.onSettled({ ok: true, text: "", ...outcome });

  it("starts the first step's turn in the run's own chat, with the run's identity", async () => {
    const r = rig();
    const { errors, row } = await begin(r);
    expect(errors).toEqual([]);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]).toMatchObject({ botId: "ana", opts: { threadId: "t-ana", runOn: "seira", automationSource: "schedule", automationRunId: row.id, continuesRun: false } });
    expect(r.turns[0]!.text).toContain("Collect the news");
  });

  it("starts no step turn once the app is closing", async () => {
    const r = rig({ shuttingDown: () => true });
    const { errors } = await begin(r);
    expect(errors).toEqual([]);
    expect(r.turns).toEqual([]);
  });

  it("does not recover its runs while the routine file cannot be read", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wfh-same-"));
    dirs.push(dataDir);
    const first = rig({ dataDir });
    const { row } = await begin(first);
    first.host.close();
    let unreadable = true;
    const second = rig({ dataDir, routinesUnreadable: () => unreadable });
    second.host.recover();
    expect(second.host.run(row.id)?.status).toBe("active");
    unreadable = false;
    second.host.recover();
    expect(second.host.run(row.id)?.status).not.toBe("active");
  });

  it("opens a new chat for the next bot, marked as this run's and unread by nobody", async () => {
    const r = rig();
    const { row } = await begin(r);
    settle(r, { text: "news" });
    expect(r.turns).toHaveLength(2);
    expect(r.turns[1]).toMatchObject({ botId: "ben", opts: { threadId: "t-new", continuesRun: true } });
    expect(r.created).toHaveLength(1);
    expect(r.created[0]![0]).toBe("ben");
    expect(String(r.created[0]![1])).toMatch(/^Morning · /);
    expect(r.patched).toEqual([["ben", "t-new", { routineRunId: row.id, unread: false }]]);
  });

  it("posts the last output and ends the run", async () => {
    const r = rig();
    const { row } = await begin(r);
    settle(r, { text: "news" });
    settle(r, { text: "digest" });
    expect(r.posts).toEqual([{ stepId: "p", text: "digest" }]);
    expect(r.states.at(-1)).toEqual([row.id, "completed", "digest"]);
    expect(r.host.run(row.id)).toMatchObject({ status: "completed" });
    expect(r.host.runs(r.host.get(row.workflowId!)!.id, 10).map((run) => run.runId)).toEqual([row.id]);
  });

  it("maps a turn that asked a question to a step that needs the person", async () => {
    const r = rig();
    const { row } = await begin(r);
    settle(r, { ok: true, text: "Which?", cards: { question: "Which?", ids: ["1"] } });
    expect(r.host.run(row.id)!.stepRuns[0]).toMatchObject({ status: "failed", errorCode: "needs_person" });
  });

  it.each<[string, Partial<HostTurnResult>, string]>([
    ["a failed turn with its cause", { ok: false, text: "said", failure: { text: "Provider error" } }, "Provider error"],
    ["a failed turn without a cause", { ok: false, text: "said" }, "said"],
    ["a failed turn with no words", { ok: false, text: "" }, "The turn failed"],
    ["a stalled turn", { ok: true, stalled: true, text: "stuck" }, "stuck"],
  ])("fails the step on %s", async (_name, outcome, error) => {
    const r = rig();
    const { row } = await begin(r);
    settle(r, outcome);
    expect(r.host.run(row.id)!.stepRuns[0]).toMatchObject({ status: "failed", errorCode: "turn_failed", error });
  });

  it.each(["thread_busy", "thread_limit"])("waits for the bot when its chat answers %s", async (code) => {
    const r = rig();
    r.state.startTurn = async () => { throw Object.assign(new Error("busy"), { code }); };
    const { row } = await begin(r);
    await Promise.resolve();
    expect(r.host.run(row.id)!.stepRuns[0]).toMatchObject({ status: "waiting", waitingFor: "bot" });
  });

  it("fails the step when starting the turn throws, or is refused", async () => {
    const r = rig();
    r.state.startTurn = async () => { throw new Error("Could not start"); };
    const { row } = await begin(r);
    await Promise.resolve();
    expect(r.host.run(row.id)!.stepRuns[0]).toMatchObject({ status: "failed", error: "Could not start" });

    const q = rig({ startTurn: () => { throw new Error("sync"); } });
    const second = await begin(q);
    expect(q.host.run(second.row.id)!.stepRuns[0]).toMatchObject({ status: "failed", error: "sync" });

    const s = rig();
    const third = await begin(s);
    s.turns[0]!.opts.onDispatchError("Not allowed");
    expect(s.host.run(third.row.id)!.stepRuns[0]).toMatchObject({ status: "failed", error: "Not allowed" });
  });

  it.each(["thread_busy", "thread_limit", "workspace_busy", "settling"])("treats %s as a busy bot and waits", async (code) => {
    const r = rig();
    r.state.startTurn = async () => { throw Object.assign(new Error("Busy"), { code }); };
    const { row } = await begin(r);
    await Promise.resolve();
    expect(r.host.run(row.id)!.stepRuns[0]).toMatchObject({ status: "waiting", waitingFor: "bot" });
  });

  it("follows a question in a step's chat", async () => {
    const r = rig();
    const { row } = await begin(r);
    const event = { eventId: "e", provider: "fake", threadId: "t-ana", createdAt: new Date(0).toISOString() };
    r.host.runtimeEvent({ ...event, type: "request.opened", requestType: "question", tool: "ask", summary: "Which account?" } as never);
    expect(r.host.run(row.id)!.stepRuns[0]).toMatchObject({ status: "waiting", waitingFor: "person" });
    r.host.runtimeEvent({ ...event, type: "request.resolved" } as never);
    expect(r.host.run(row.id)!.stepRuns[0]).toMatchObject({ status: "running" });
    r.host.runtimeEvent({ ...event, type: "turn.completed", ok: true } as never);
  });

  it("stops a run's turn when its routine run ends", async () => {
    const interrupted: Array<[string, string]> = [];
    const r = rig({ routineHooks: () => ({ createTask: (() => ({ threadId: "t-new" })) as never, interruptTurn: async (botId: string, threadId: string) => { interrupted.push([botId, threadId]); } }) });
    const { row } = await begin(r);
    r.host.routineRunChanged({ ...row, status: "cancelled", error: "Stopped by you" });
    expect(r.host.run(row.id)).toMatchObject({ status: "stopped" });
    expect(interrupted).toEqual([["ana", "t-ana"]]);
  });

  it("goes on with the next step when a wait ends", async () => {
    vi.useFakeTimers();
    const r = rig();
    const body: WorkflowInput = { name: "W", steps: [bot("a", "ana", "Collect"), { id: "w", kind: "wait", minutes: 5, position: at }, bot("b", "ben", "Write")], connections: [{ id: "1", from: "a", to: "w" }, { id: "2", from: "w", to: "b" }] };
    const { row } = await begin(r, body);
    settle(r, { text: "news" });
    expect(r.turns).toHaveLength(1);
    r.tick(5 * 60_000);
    vi.advanceTimersByTime(5 * 60_000);
    expect(r.turns).toHaveLength(2);
    expect(r.host.run(row.id)!.stepRuns.find((step) => step.stepId === "w")?.status).toBe("done");
  });

  it("keeps a wait longer than a timer can hold armed", async () => {
    vi.useFakeTimers();
    const r = rig();
    const body: WorkflowInput = { name: "W", steps: [bot("a", "ana", "Collect"), { id: "w", kind: "wait", minutes: 43_200, position: at }, bot("b", "ben", "Write")], connections: [{ id: "1", from: "a", to: "w" }, { id: "2", from: "w", to: "b" }] };
    await begin(r, body);
    settle(r, { text: "news" });
    vi.advanceTimersByTime(2 ** 31);
    expect(r.turns).toHaveLength(1);
    r.tick(43_200 * 60_000);
    vi.advanceTimersByTime(2 ** 31);
    expect(r.turns).toHaveLength(2);
  });
});

describe("a room goal that runs steps", () => {
  const roomRig = (memberIds = ["ana", "ben"]) => {
    const roomTurns: WorkflowRoomTurn[] = [];
    const stopped: Array<[string, string]> = [];
    const interrupted: Array<[string, string]> = [];
    const r = rig({
      rooms: { room: (id) => (id === "room-1" ? { memberIds } : null), startTurn: (turn) => { roomTurns.push(turn); }, stopTurn: async (groupId, threadId) => { stopped.push([groupId, threadId]); } },
      routineHooks: () => ({ createTask: (() => ({ threadId: "t-new" })) as never, interruptTurn: async (botId: string, threadId: string) => { interrupted.push([botId, threadId]); } }),
    });
    const begin = async () => {
      const made = r.host.create(noPost());
      const row = r.run({ workflowId: made.id, target: "room-goal", groupId: "room-1", threadId: "t-room" });
      const errors: string[] = [];
      await r.host.start(row, "t-room", (message) => errors.push(message));
      return { row, errors };
    };
    const seen = () => roomTurns.map((turn) => [turn.groupId, turn.threadId, turn.botId, turn.continuesRun]);
    return { r, roomTurns, stopped, interrupted, begin, seen };
  };

  it("room goal runs each step in the room", async () => {
    const { r, roomTurns, begin, seen } = roomRig();
    const { row, errors } = await begin();
    expect(errors).toEqual([]);
    expect(r.turns).toEqual([]);
    expect(seen()).toEqual([["room-1", "t-room", "ana", false]]);
    expect(roomTurns[0]).toMatchObject({ runId: row.id });
    expect(roomTurns[0]!.prompt).toContain("Collect the news");
    roomTurns[0]!.settle({ ok: true, text: "Three stories" });
    expect(seen()).toEqual([["room-1", "t-room", "ana", false], ["room-1", "t-room", "ben", true]]);
    expect(roomTurns[1]!.prompt).toContain("Three stories");
    expect(r.created).toEqual([]);
    roomTurns[1]!.settle({ ok: true, text: "digest" });
    expect(r.host.run(row.id)).toMatchObject({ status: "completed" });
    expect(r.host.run(row.id)!.stepRuns.map((step) => [step.stepId, step.status, step.output])).toEqual([["a", "done", "Three stories"], ["b", "done", "digest"]]);
    expect(r.states.at(-1)).toEqual([row.id, "completed", "digest"]);
  });

  it("a room goal refuses a workflow whose bot is not in the room", async () => {
    const { r, roomTurns, begin } = roomRig(["ana"]);
    const { row, errors } = await begin();
    expect(errors).toEqual(["Ben isn't in this room. Add Ben to the room first."]);
    expect(roomTurns).toEqual([]);
    expect(r.host.run(row.id)).toBeNull();
  });

  it("fails a room goal's step that its room could not run, with the room's reason", async () => {
    const { r, roomTurns, begin } = roomRig();
    const { row } = await begin();
    roomTurns[0]!.settle({ ok: false, error: "Ana is no longer available." });
    expect(r.host.run(row.id)!.stepRuns[0]).toMatchObject({ status: "failed", error: "Ana is no longer available." });
    expect(r.host.run(row.id)).toMatchObject({ status: "failed" });
  });

  it("stopping a room-goal workflow run stops the room turn", async () => {
    const { r, stopped, interrupted, begin } = roomRig();
    const { row } = await begin();
    r.host.routineRunChanged({ ...row, status: "cancelled", error: "Stopped by you" });
    await Promise.resolve();
    expect(r.host.run(row.id)).toMatchObject({ status: "stopped" });
    expect(stopped).toEqual([["room-1", "t-room"]]);
    expect(interrupted).toEqual([]);
  });
});

describe("running again from a step", () => {
  it("starts the routine again and prepares the run at the step", async () => {
    const r = rig();
    const made = r.host.create(input());
    const row = r.run({ workflowId: made.id });
    await r.host.start(row, "t-ana", () => {});
    r.turns[0]!.opts.onSettled({ ok: true, text: "news" });
    r.turns[1]!.opts.onSettled({ ok: false, text: "boom" });
    const second = r.run({ id: "run-2", workflowId: made.id, threadId: "t-ana" });
    r.runRows.push(row);
    expect(r.host.runAgain("run-1", "b", { id: "r-1" } as Routine, made)).toBe(second);
    expect(r.host.run("run-2")).toMatchObject({ startStepId: "b", fromRunId: "run-1" });
  });

  it("queues a webhook run again with the stored event and prepares it at the step", async () => {
    const r = rig();
    const made = r.host.create(input());
    const row = r.run({ workflowId: made.id, routineId: "hook-1", webhookId: "hook-1", triggerSource: "webhook", prompt: "EVENT order 42", routineName: "Orders" });
    await r.host.start(row, "t-ana", () => {});
    r.turns[0]!.opts.onSettled({ ok: true, text: "news" });
    r.turns[1]!.opts.onSettled({ ok: false, text: "boom" });
    const second = r.run({ id: "run-2", workflowId: made.id, routineId: "hook-1", webhookId: "hook-1", triggerSource: "webhook", prompt: "EVENT order 42", threadId: "t-ana" });
    r.runRows.push(row);
    expect(r.host.runAgainFromEvent("run-1", "b", "hook-1", made, "ben")).toBe(second);
    expect(r.enqueued[0]).toMatchObject({ botId: "ben", webhookId: "hook-1", prompt: "EVENT order 42", workflowId: made.id });
    expect(r.host.run("run-2")).toMatchObject({ startStepId: "b", fromRunId: "run-1" });
  });

  it("cancels the new run and throws when the step is gone", async () => {
    const r = rig();
    const made = r.host.create(input());
    const row = r.run({ workflowId: made.id });
    await r.host.start(row, "t-ana", () => {});
    expect(() => r.host.runAgain("run-1", "gone", { id: "r-1" } as Routine, made)).toThrow("That step is no longer in the workflow.");
    expect(r.cancelled).toEqual(["run-1"]);
  });

  it("returns null for a run it does not know", () => {
    const r = rig();
    expect(r.host.runAgain("nope", "a", { id: "r-1" } as Routine, r.host.create(noPost()))).toBeNull();
  });
});

describe("a run that keeps one conversation", () => {
  beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); });
  const sonnet = { instanceId: "claude", model: "claude-sonnet-5" };
  const opus = { instanceId: "claude", model: "claude-opus-5" };
  const fence = (runs: RoutineRun[]) => createReadAndDraft({ runFor: (threadId) => runOfThread(runs, threadId), adapter: () => undefined, stale: () => false, decide: () => {}, release: () => {}, mayDraft: () => false, drafted: () => {} });

  /** A real Store. Each run goes through Ana, then Ben, and keeps Ana's chat; earlier runs stay in the run list. */
  const kept = () => {
    const store = new Store(() => sonnet);
    const ana = store.createBot({ name: "Ana" });
    const ben = store.createBot({ name: "Ben" });
    for (const each of [ana, ben]) store.setAllThreadApprovalMode(each.id, "full");
    const r = rig({ store, routineHooks: () => ({ createTask: ((botId: string, title: string, _run: unknown, modelSelection?: ModelSelection) => store.createTask(botId, title, false, undefined, undefined, undefined, modelSelection)) as never, interruptTurn: async () => {} }) });
    const steps = (writer: string): WorkflowInput => ({ name: "Morning", steps: [bot("a", ana.id, "Collect the news"), bot("b", writer, "Write the digest")], connections: [{ id: "1", from: "a", to: "b" }] });
    const made = r.host.create(steps(ben.id));
    r.routineRows.push({ id: "r-1", workflowId: made.id, sameConversation: true } as Routine);
    const once = async (over: Partial<RoutineRun> = {}) => {
      const row = { id: `run-${r.runRows.length + 1}`, routineId: "r-1", routineName: "Morning", botId: ana.id, target: "bot", status: "running", manual: false, runOn: "seira", workflowId: made.id, threadId: ana.threadId, sameConversation: true, startedAt: Date.now(), ...over } as RoutineRun;
      r.runRows.push(row);
      await r.host.start(row, row.threadId!, () => {});
      r.turns.at(-1)!.opts.onSettled({ ok: true, text: "news" });
      const writer = r.turns.at(-1)!;
      writer.opts.onSettled({ ok: true, text: "digest" });
      row.status = "completed";
      return { row, writer: writer.opts.threadId, writerBot: writer.botId };
    };
    return { r, store, ana, ben, made, steps, once };
  };

  it("goes on in the chat its earlier run used for a step while nothing changed", async () => {
    const k = kept();
    const first = await k.once();
    expect(first.writerBot).toBe(k.ben.id);
    expect(k.store.taskByThread(k.ben.id, first.writer)).toBeTruthy();
    expect((await k.once()).writer).toBe(first.writer);
  });

  it.each<[string, (k: ReturnType<typeof kept>, chat: string) => Partial<RoutineRun> | void]>([
    ["the chat's model changed", (k, chat) => { k.store.patchTask(k.ben.id, chat, { modelSelection: opus }); }],
    ["the automation's model changed", (k) => { k.r.routineRows[0]!.modelSelection = opus; }],
    ["the chat's approval changed", (k, chat) => { k.store.patchTask(k.ben.id, chat, { approvalMode: "ask", autoApprove: false }); }],
    ["the chat's always-allowed tools changed", (k, chat) => { k.store.patchTask(k.ben.id, chat, { alwaysAllow: ["Bash"] }); }],
    ["the bot's approval changed", (k) => { k.store.patchBot(k.ben.id, { approvalMode: "ask", autoApprove: false }); }],
    ["the run's access changed to read and draft", () => ({ access: "read-and-draft" })],
  ])("opens a new chat for the step when %s", async (_name, change) => {
    const k = kept();
    const first = await k.once();
    const next = await k.once(change(k, first.writer) ?? {});
    expect(next.writer).not.toBe(first.writer);
    expect(k.store.taskByThread(k.ben.id, next.writer)).toBeTruthy();
  });

  it("opens a new chat when the step's bot changed", async () => {
    const k = kept();
    const first = await k.once();
    const cara = k.store.createBot({ name: "Cara" });
    k.r.host.update(k.made.id, k.steps(cara.id));
    const next = await k.once();
    expect(next.writerBot).toBe(cara.id);
    expect(next.writer).not.toBe(first.writer);
    expect(k.store.taskByThread(cara.id, next.writer)).toBeTruthy();
  });

  it.each([
    ["full access", "reads and drafts only", undefined, "read-and-draft"],
    ["reads and drafts only", "full access", "read-and-draft", undefined],
  ] as const)("keeps a waiting older run with %s and a newer run with %s apart, and the stricter access wins in a chat they share", async (_older, _newer, olderAccess, newerAccess) => {
    const k = kept();
    const older = await k.once(olderAccess ? { access: olderAccess } : {});
    older.row.status = "waiting";
    const newer = await k.once(newerAccess ? { access: newerAccess } : {});
    newer.row.status = "running";
    const gate = fence(k.r.runRows);
    expect(newer.writer).not.toBe(older.writer);
    expect(gate.confines(older.writer)).toBe(olderAccess !== undefined);
    expect(gate.confines(newer.writer)).toBe(newerAccess !== undefined);
    expect(gate.confines(k.ana.threadId)).toBe(true);
    expect(runOfThread(k.r.runRows, k.ana.threadId)).toMatchObject({ id: newer.row.id, access: "read-and-draft" });
  });
});
