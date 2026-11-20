import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Workflow, WorkflowRun, WorkflowRunUpdate } from "../../shared/workflows";
import type { LiveFrameListener } from "@/lib/live-events";
import { ApiError } from "./api";

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  listener: null as null | LiveFrameListener,
  effects: [] as Array<() => void>,
}));
vi.mock("@/state/store", async () => ({ api: fixture.api, ApiError: (await import("./api")).ApiError }));
vi.mock("@/lib/live-events", () => ({
  listenLiveFrames: (listener: LiveFrameListener) => {
    fixture.listener = listener;
    return () => { fixture.listener = null; };
  },
}));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: (effect: () => void) => { fixture.effects.push(effect); },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

import {
  applyWorkflowFrame,
  keepDraft,
  loadWorkflowRun,
  loadWorkflowRuns,
  loadWorkflows,
  resetWorkflowsForTest,
  runsOf,
  takeDraft,
  useWorkflows,
  workflowApi,
} from "./workflows";

const settle = () => new Promise((resolve) => setTimeout(resolve));
const snapshot = () => useWorkflows();
const flow = (id: string, updatedAt = 1, name = "Morning"): Workflow => ({ id, name, steps: [], connections: [], createdAt: 1, updatedAt });
const update = (runId: string, patch: Partial<WorkflowRunUpdate> = {}): WorkflowRunUpdate => ({
  runId, workflowId: "w1", routineId: "rt1", workflowName: "Morning", status: "active", botIds: [], startStepId: "a",
  threads: {}, stepRuns: [], createdAt: 1, updatedAt: 1, ...patch,
});
const full = (runId: string, patch: Partial<WorkflowRun> = {}): WorkflowRun => ({ ...update(runId), graph: { steps: [], connections: [] }, ...patch });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

afterEach(() => { vi.useRealTimers(); });

beforeEach(() => {
  resetWorkflowsForTest();
  fixture.api.mockReset();
  fixture.effects = [];
  fixture.listener = null;
});

describe("workflows on the client", () => {
  it("loads the workflows once even when two views ask at the same time", async () => {
    const pending = deferred<{ workflows: Workflow[] }>();
    fixture.api.mockReturnValue(pending.promise);
    const first = loadWorkflows();
    const second = loadWorkflows();
    expect(fixture.api).toHaveBeenCalledTimes(1);
    pending.resolve({ workflows: [flow("w1")] });
    await Promise.all([first, second]);
    expect(snapshot()).toMatchObject({ loaded: true, unavailable: false, failed: false, workflows: [flow("w1")] });
    await loadWorkflows();
    expect(fixture.api).toHaveBeenCalledTimes(2);
  });

  it("marks workflows unavailable when the list answers 404", async () => {
    fixture.api.mockRejectedValueOnce(new ApiError("gone", 404));
    await loadWorkflows();
    expect(snapshot().unavailable).toBe(true);
    fixture.api.mockResolvedValueOnce({ workflows: [] });
    await loadWorkflows();
    expect(snapshot().unavailable).toBe(false);
  });

  it("tries again after a 503 while the server starts, and marks workflows unavailable only after the last try", async () => {
    vi.useFakeTimers();
    fixture.api.mockRejectedValueOnce(new ApiError("starting", 503)).mockRejectedValueOnce(new ApiError("starting", 503)).mockResolvedValueOnce({ workflows: [flow("w1")] });
    const done = loadWorkflows();
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot().loaded).toBe(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fixture.api).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3000);
    await done;
    expect(snapshot()).toMatchObject({ loaded: true, unavailable: false, workflows: [flow("w1")] });
    fixture.api.mockReset();
    fixture.api.mockRejectedValue(new ApiError("down", 503));
    const failing = loadWorkflows();
    await vi.advanceTimersByTimeAsync(3000 * 3);
    await failing;
    expect(fixture.api).toHaveBeenCalledTimes(4);
    expect(snapshot().unavailable).toBe(true);
  });

  it("keeps a workflow that arrived by frame while the list was loading, and drops one deleted meanwhile", async () => {
    const pending = deferred<{ workflows: Workflow[] }>();
    fixture.api.mockReturnValue(pending.promise);
    const load = loadWorkflows();
    applyWorkflowFrame({ kind: "workflow", workflow: flow("new", 5) });
    applyWorkflowFrame({ kind: "workflow.deleted", workflowId: "old" });
    pending.resolve({ workflows: [flow("w1"), flow("old")] });
    await load;
    expect(snapshot().workflows.map((workflow) => workflow.id)).toEqual(["new", "w1"]);
    applyWorkflowFrame({ kind: "workflow", workflow: flow("old", 9) });
    expect(snapshot().workflows.map((workflow) => workflow.id)).toEqual(["new", "w1"]);
  });

  it("keeps the newer copy of a workflow when the list answers with an older one", async () => {
    const pending = deferred<{ workflows: Workflow[] }>();
    fixture.api.mockReturnValue(pending.promise);
    const load = loadWorkflows();
    applyWorkflowFrame({ kind: "workflow", workflow: flow("w1", 8, "Edited") });
    pending.resolve({ workflows: [flow("w1", 2, "Old")] });
    await load;
    expect(snapshot().workflows).toEqual([flow("w1", 8, "Edited")]);
  });

  it("keeps a completed run when a frame says so while its detail is loading", async () => {
    const pending = deferred<{ run: WorkflowRun }>();
    fixture.api.mockReturnValue(pending.promise);
    const load = loadWorkflowRun("r1");
    applyWorkflowFrame({ kind: "workflow.run", run: update("r1", { status: "completed", updatedAt: 5 }) });
    pending.resolve({ run: full("r1", { status: "active", updatedAt: 3, graph: { steps: [{ id: "a", kind: "post", position: { x: 0, y: 0 } }], connections: [] } }) });
    const run = await load;
    expect(run).toMatchObject({ status: "completed", updatedAt: 5 });
    expect(snapshot().runs.r1).toMatchObject({ status: "completed" });
    expect(snapshot().details.r1).toMatchObject({ status: "completed" });
    expect(snapshot().details.r1!.graph.steps).toHaveLength(1);
  });

  it("marks a failed load on a network error and keeps the workflows it had", async () => {
    fixture.api.mockResolvedValueOnce({ workflows: [flow("w1")] });
    await loadWorkflows();
    fixture.api.mockRejectedValueOnce(new TypeError("offline"));
    await loadWorkflows();
    expect(snapshot()).toMatchObject({ loaded: true, failed: true, unavailable: false, workflows: [flow("w1")] });
    fixture.api.mockRejectedValueOnce(new ApiError("asleep", 503, { error: "asleep" }));
    await loadWorkflows();
    expect(snapshot()).toMatchObject({ failed: true, unavailable: false });
  });

  it("adds, replaces and removes a workflow from frames, and ignores an older copy", () => {
    applyWorkflowFrame({ kind: "workflow", workflow: flow("w1", 5, "One") });
    applyWorkflowFrame({ kind: "workflow", workflow: flow("w2", 5, "Two") });
    expect(snapshot().workflows.map((workflow) => workflow.id)).toEqual(["w2", "w1"]);
    applyWorkflowFrame({ kind: "workflow", workflow: flow("w1", 6, "One again") });
    expect(snapshot().workflows.find((workflow) => workflow.id === "w1")?.name).toBe("One again");
    applyWorkflowFrame({ kind: "workflow", workflow: flow("w1", 4, "Old") });
    expect(snapshot().workflows.find((workflow) => workflow.id === "w1")?.name).toBe("One again");
    applyWorkflowFrame({ kind: "workflow.deleted", workflowId: "w1" });
    expect(snapshot().workflows.map((workflow) => workflow.id)).toEqual(["w2"]);
  });

  it("keeps run updates by run id, newest first, and at most 200", () => {
    for (let index = 0; index < 205; index += 1) {
      applyWorkflowFrame({ kind: "workflow.run", run: update(`r${index}`, { createdAt: 100 + index, updatedAt: 100 + index }) });
    }
    const state = snapshot();
    expect(Object.keys(state.runs)).toHaveLength(200);
    expect(state.runs.r0).toBeUndefined();
    expect(state.runs.r4).toBeUndefined();
    expect(state.runs.r5).toBeDefined();
    const runs = runsOf(state, "w1");
    expect(runs[0]?.runId).toBe("r204");
    expect(runs.at(-1)?.runId).toBe("r5");
    applyWorkflowFrame({ kind: "workflow.run", run: update("r204", { status: "completed", createdAt: 304, updatedAt: 400 }) });
    expect(snapshot().runs.r204?.status).toBe("completed");
    applyWorkflowFrame({ kind: "workflow.run", run: update("r204", { status: "active", createdAt: 304, updatedAt: 300 }) });
    expect(snapshot().runs.r204?.status).toBe("completed");
  });

  it("merges a run frame into a loaded run and keeps the full output of a clipped step", async () => {
    const graph = { steps: [{ id: "a", kind: "bot" as const, botId: "ana", instruction: "Do", position: { x: 0, y: 0 } }], connections: [] };
    fixture.api.mockResolvedValueOnce({ run: full("r1", {
      graph,
      stepRuns: [{ stepId: "a", status: "done", output: "the full output", finishedAt: 10 }],
    }) });
    await loadWorkflowRun("r1");
    applyWorkflowFrame({ kind: "workflow.run", run: update("r1", {
      status: "completed",
      updatedAt: 2,
      stepRuns: [
        { stepId: "a", status: "done", output: "the fu", outputClipped: true, finishedAt: 10 },
        { stepId: "b", status: "running", startedAt: 11 },
      ],
    }) });
    const detail = snapshot().details.r1!;
    expect(detail.status).toBe("completed");
    expect(detail.graph).toEqual(graph);
    expect(detail.stepRuns[0]).toEqual({ stepId: "a", status: "done", output: "the full output", finishedAt: 10 });
    expect(detail.stepRuns[1]?.status).toBe("running");
    applyWorkflowFrame({ kind: "workflow.run", run: update("r1", {
      updatedAt: 3,
      stepRuns: [{ stepId: "a", status: "done", output: "new clip", outputClipped: true, finishedAt: 12 }],
    }) });
    expect(snapshot().details.r1?.stepRuns[0]).toMatchObject({ output: "new clip", outputClipped: true });
  });

  it("loads one run once while a load is running, and again on force", async () => {
    const pending = deferred<{ run: WorkflowRun }>();
    fixture.api.mockReturnValueOnce(pending.promise);
    const first = loadWorkflowRun("r1");
    const second = loadWorkflowRun("r1");
    expect(fixture.api).toHaveBeenCalledTimes(1);
    expect(fixture.api).toHaveBeenCalledWith("/api/workflow-runs/r1");
    pending.resolve({ run: full("r1") });
    expect(await first).toEqual(await second);
    expect(snapshot().details.r1).toBeDefined();
    expect(snapshot().runs.r1).toBeDefined();
    expect(snapshot().runs.r1).not.toHaveProperty("graph");
    await loadWorkflowRun("r1");
    expect(fixture.api).toHaveBeenCalledTimes(1);
    fixture.api.mockResolvedValueOnce({ run: full("r1", { status: "completed", updatedAt: 9 }) });
    await loadWorkflowRun("r1", { force: true });
    expect(fixture.api).toHaveBeenCalledTimes(2);
    expect(snapshot().details.r1?.status).toBe("completed");
    fixture.api.mockRejectedValueOnce(new ApiError("no such run", 404));
    expect(await loadWorkflowRun("missing")).toBeNull();
    fixture.api.mockRejectedValueOnce(new TypeError("offline"));
    await expect(loadWorkflowRun("again")).rejects.toThrow("offline");
  });

  it("lists the runs of one workflow for one routine, newest first", async () => {
    fixture.api.mockResolvedValueOnce({ runs: [
      update("r1", { createdAt: 10 }),
      update("r2", { createdAt: 30 }),
      update("r3", { createdAt: 20, routineId: "rt2" }),
      update("r4", { createdAt: 40, workflowId: "w2" }),
    ] });
    await loadWorkflowRuns("w1", 5);
    expect(fixture.api).toHaveBeenCalledWith("/api/workflows/w1/runs?limit=5");
    const state = snapshot();
    expect(runsOf(state, "w1").map((run) => run.runId)).toEqual(["r2", "r3", "r1"]);
    expect(runsOf(state, "w1", "rt1").map((run) => run.runId)).toEqual(["r2", "r1"]);
    expect(runsOf(state, "w2").map((run) => run.runId)).toEqual(["r4"]);
    fixture.api.mockRejectedValueOnce(new TypeError("offline"));
    await loadWorkflowRuns("w1");
    expect(runsOf(snapshot(), "w1")).toHaveLength(3);
  });

  it("saves through PATCH with ifUpdatedAt and puts the saved workflow in the list", async () => {
    applyWorkflowFrame({ kind: "workflow", workflow: flow("w1", 1, "Before") });
    fixture.api.mockResolvedValueOnce({ workflow: flow("w1", 2, "After") });
    const saved = await workflowApi.save("w1", { name: "After", steps: [], connections: [], ifUpdatedAt: 1 });
    expect(saved.updatedAt).toBe(2);
    expect(fixture.api).toHaveBeenCalledWith("/api/workflows/w1", {
      method: "PATCH",
      body: JSON.stringify({ name: "After", steps: [], connections: [], ifUpdatedAt: 1 }),
    });
    expect(snapshot().workflows).toEqual([flow("w1", 2, "After")]);
    fixture.api.mockRejectedValueOnce(new ApiError("changed", 409, { code: "workflow_changed" }));
    await expect(workflowApi.save("w1", { name: "X", steps: [], connections: [], ifUpdatedAt: 1 })).rejects.toBeInstanceOf(ApiError);
    expect(snapshot().workflows).toEqual([flow("w1", 2, "After")]);
  });

  it("creates, deletes and runs again through the workflow routes", async () => {
    fixture.api.mockResolvedValueOnce({ workflow: flow("w9", 1, "New") });
    await workflowApi.create({ name: "New", steps: [], connections: [] });
    expect(fixture.api).toHaveBeenLastCalledWith("/api/workflows", { method: "POST", body: JSON.stringify({ name: "New", steps: [], connections: [] }) });
    expect(snapshot().workflows.map((workflow) => workflow.id)).toEqual(["w9"]);
    fixture.api.mockResolvedValueOnce({ ok: true });
    await workflowApi.remove("w9");
    expect(fixture.api).toHaveBeenLastCalledWith("/api/workflows/w9", { method: "DELETE" });
    expect(snapshot().workflows).toEqual([]);
    const started = { id: "routine-run-2" };
    fixture.api.mockResolvedValueOnce({ run: started });
    expect(await workflowApi.runAgain("r1", "a")).toBe(started);
    expect(fixture.api).toHaveBeenLastCalledWith("/api/workflow-runs/r1/steps/a/run-again", { method: "POST" });
    fixture.api.mockRejectedValueOnce(new ApiError("busy", 409));
    await expect(workflowApi.runAgain("r1", "a")).rejects.toMatchObject({ status: 409 });
    fixture.api.mockRejectedValueOnce(new ApiError("refused", 403));
    await expect(workflowApi.remove("w9")).rejects.toMatchObject({ status: 403 });
  });

  it("keeps an unsaved draft per workflow until it is taken or the workflow is deleted", () => {
    const draft = { name: "Draft", steps: [], connections: [] };
    keepDraft("w1", draft, 7);
    keepDraft("w2", { ...draft, name: "Other" }, 8);
    expect(takeDraft("w1")).toEqual({ draft, base: 7 });
    expect(takeDraft("w1")).toBeUndefined();
    applyWorkflowFrame({ kind: "workflow.deleted", workflowId: "w2" });
    expect(takeDraft("w2")).toBeUndefined();
  });

  it("reloads in the background after missed frames", async () => {
    fixture.api.mockResolvedValue({ workflows: [flow("w1")] });
    snapshot();
    for (const effect of fixture.effects) effect();
    await settle();
    expect(fixture.api).toHaveBeenCalledTimes(1);
    expect(fixture.api).toHaveBeenLastCalledWith("/api/workflows", undefined);
    fixture.listener?.onFrame({ kind: "workflow", workflow: flow("w2", 3) });
    expect(snapshot().workflows.map((workflow) => workflow.id)).toEqual(["w2", "w1"]);
    fixture.api.mockResolvedValue({ workflows: [flow("w1"), flow("w3")] });
    fixture.listener?.onMissedFrames?.();
    await settle();
    expect(fixture.api).toHaveBeenCalledTimes(2);
    expect(fixture.api).toHaveBeenLastCalledWith("/api/workflows", { background: true });
    expect(snapshot().workflows.map((workflow) => workflow.id)).toEqual(["w1", "w3"]);
    for (const effect of fixture.effects) effect();
    expect(fixture.api).toHaveBeenCalledTimes(2);
  });
});
