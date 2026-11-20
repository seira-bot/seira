import { mkdtempSync, rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Workflow, WorkflowRun, WorkflowStepRun } from "../../shared/workflows.ts";
import { openWorkflowStore, type WorkflowStore } from "./store.ts";

const workflow = (id: string, updatedAt = 1): Workflow => ({
  id, name: `Flow ${id}`, createdAt: 1, updatedAt,
  steps: [
    { id: "a", kind: "bot", botId: "bot-1", instruction: "Collect the news", position: { x: 10, y: 20 } },
    { id: "b", kind: "check", question: "Is there news?", position: { x: 30, y: 40 } },
    { id: "c", kind: "post", position: { x: 50, y: 60 } },
  ],
  connections: [{ id: "k1", from: "a", to: "b" }, { id: "k2", from: "b", to: "c", branch: "yes" }],
});

const step = (stepId: string, status: WorkflowStepRun["status"], extra: Partial<WorkflowStepRun> = {}): WorkflowStepRun => ({ stepId, status, ...extra });

const run = (runId: string, createdAt: number, status: WorkflowRun["status"] = "completed", workflowId = "w1"): WorkflowRun => ({
  runId, workflowId, routineId: "r1", workflowName: "Flow", status, graph: workflow(workflowId), botIds: ["bot-1"], startStepId: "a",
  threads: { "bot-1": "t1" }, createdAt, updatedAt: createdAt,
  stepRuns: [step("a", "done", { output: "news", botId: "bot-1" }), step("b", "running"), step("c", "waiting")],
});

describe("the workflow store", () => {
  const dirs: string[] = [];
  const stores: WorkflowStore[] = [];
  const folder = () => { const dir = mkdtempSync(join(tmpdir(), "wfs-")); dirs.push(dir); return dir; };
  const open = (dir: string) => { const store = openWorkflowStore(dir); stores.push(store); return store; };
  afterEach(() => {
    for (const store of stores.splice(0)) try { store.close(); } catch { /* closed by the test */ }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a workflow's name, steps, connections and positions after a reopen", () => {
    const dir = folder();
    const first = open(dir);
    first.putWorkflow(workflow("w1"));
    first.close();
    const again = open(dir);
    expect(again.workflow("w1")).toEqual(workflow("w1"));
    expect(again.listWorkflows()).toEqual([workflow("w1")]);
  });

  it("keeps a run and its step runs after a reopen", () => {
    const dir = folder();
    const first = open(dir);
    first.putRun(run("run-1", 5, "active"));
    first.close();
    const again = open(dir);
    expect(again.run("run-1")).toEqual(run("run-1", 5, "active"));
    expect(again.activeRuns().map((r) => r.runId)).toEqual(["run-1"]);
    expect(again.runsOf("w1", 10).map((r) => r.runId)).toEqual(["run-1"]);
  });

  it("creates the file with mode 0600", () => {
    const dir = folder();
    open(dir);
    expect(statSync(join(dir, "workflows.db")).mode & 0o777).toBe(0o600);
  });

  it("prunes finished runs beyond the newest 2,000", () => {
    const store = open(":memory:");
    store.putRun(run("active-old", 0, "active"));
    for (let i = 1; i <= 2_005; i += 1) store.putRun({ ...run(`run-${i}`, i), stepRuns: [step("a", "done")] });
    expect(store.prune()).toBe(5);
    expect(store.run("run-5")).toBeNull();
    expect(store.run("run-6")).not.toBeNull();
    expect(store.run("active-old")).not.toBeNull();
    expect(store.runsOf("w1", 5_000)).toHaveLength(2_001);
    expect(store.prune()).toBe(0);
  });

  it("removes the step runs of a pruned run", () => {
    const dir = folder();
    const store = open(dir);
    store.putRun(run("old", 1));
    store.putRun(run("new", 2));
    expect(store.prune(1)).toBe(1);
    store.close();
    const db = new DatabaseSync(join(dir, "workflows.db"));
    const left = db.prepare("SELECT DISTINCT run_id FROM workflow_step_runs").all();
    db.close();
    expect(left).toEqual([{ run_id: "new" }]);
  });

  it("replaces a workflow on a second save and deletes it", () => {
    const store = open(":memory:");
    store.putWorkflow(workflow("w1", 1));
    store.putWorkflow({ ...workflow("w1", 2), name: "Renamed" });
    expect(store.listWorkflows()).toHaveLength(1);
    expect(store.workflow("w1")?.name).toBe("Renamed");
    expect(store.deleteWorkflow("w1")).toBe(true);
    expect(store.deleteWorkflow("w1")).toBe(false);
    expect(store.workflow("w1")).toBeNull();
  });

  it("lists the newest workflow first", () => {
    const store = open(":memory:");
    store.putWorkflow(workflow("old", 1));
    store.putWorkflow(workflow("new", 9));
    expect(store.listWorkflows().map((w) => w.id)).toEqual(["new", "old"]);
  });

  it("writes one step run and the run header in one move, and keeps the order of first writes", () => {
    const store = open(":memory:");
    store.putRun({ ...run("run-1", 1, "active"), stepRuns: [] });
    store.putStep({ runId: "run-1", updatedAt: 2, currentStepId: "a", status: "active" }, step("a", "running"));
    store.putStep({ runId: "run-1", updatedAt: 3, currentStepId: "b", status: "active" }, step("b", "running"));
    store.putStep({ runId: "run-1", updatedAt: 4, currentStepId: undefined, status: "completed" }, step("a", "done", { output: "x" }));
    const saved = store.run("run-1")!;
    expect(saved.stepRuns.map((s) => [s.stepId, s.status])).toEqual([["a", "done"], ["b", "running"]]);
    expect(saved.updatedAt).toBe(4);
    expect(saved.status).toBe("completed");
    expect(saved.currentStepId).toBeUndefined();
    expect(store.activeRuns()).toEqual([]);
  });

  it("ignores a step write for a run that does not exist", () => {
    const store = open(":memory:");
    store.putStep({ runId: "ghost", updatedAt: 1, status: "active" }, step("a", "running"));
    expect(store.run("ghost")).toBeNull();
  });

  it("keeps JSON fields it does not know", () => {
    const store = open(":memory:");
    store.putWorkflow({ ...workflow("w1"), later: { added: true } } as Workflow);
    store.putRun({ ...run("run-1", 1), extra: 7, stepRuns: [{ ...step("a", "done"), more: "yes" } as WorkflowStepRun] } as WorkflowRun);
    expect((store.workflow("w1") as Workflow & { later?: unknown }).later).toEqual({ added: true });
    const saved = store.run("run-1") as WorkflowRun & { extra?: number };
    expect(saved.extra).toBe(7);
    expect((saved.stepRuns[0] as WorkflowStepRun & { more?: string }).more).toBe("yes");
  });
});
