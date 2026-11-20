import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkflowFrame, WorkflowInput, WorkflowStep } from "../../shared/workflows.ts";
import type { HostTurnResult } from "../coordinator.ts";
import type { Routine, RoutineRun } from "../routines.ts";
import { createWorkflowHost, type WorkflowHost, type WorkflowHostDeps, type WorkflowTurnOptions } from "./workflow-host.ts";

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
  const routineRows: Routine[] = [];
  const runRows: RoutineRun[] = [];
  const state = { startTurn: undefined as undefined | ((botId: string) => Promise<unknown>), failUpdate: false };
  const deps: WorkflowHostDeps = {
    dataDir: dir,
    store: { bot: (id: string) => ({ name: ({ ana: "Ana", ben: "Ben" } as Record<string, string>)[id] }) as never, patchTask: ((...args: unknown[]) => { patched.push(args); }) as never },
    routines: () => ({
      listRoutines: () => routineRows,
      listRuns: () => runRows,
      runNow: () => runRows[0] ?? null,
      cancelRun: async (id: string) => { cancelled.push(id); return null; },
      update: ((id: string, patch: unknown) => { if (state.failUpdate) throw new Error("nope"); updates.push([id, patch]); return null; }) as never,
      workflowRunState: ((runId: string, s: string, detail?: string) => { states.push([runId, s, detail]); return runRows.find((row) => row.id === runId) ?? null; }) as never,
    }),
    routineHooks: () => ({ createTask: ((...args: unknown[]) => { created.push(args); return { threadId: "t-new" }; }) as never, interruptTurn: async () => {} }),
    botState: () => "ready",
    startTurn: async (botId, text, opts) => { turns.push({ botId, text, opts }); return state.startTurn?.(botId); },
    reports: { postStep: ((_run: unknown, stepId: string, text: string, written: () => void) => { posts.push({ stepId, text }); written(); }) as never },
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
  return { host, frames, turns, patched, created, updates, logs, posts, cancelled, states, routineRows, runRows, run, state, tick: (ms: number) => { now += ms; } };
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
