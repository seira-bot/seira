import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Workflow, WorkflowRun, WorkflowRunStatus, WorkflowStepRun } from "../../shared/workflows.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_creators (
  workflow_id TEXT PRIMARY KEY,
  creator TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_runs (
  run_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  routine_id TEXT NOT NULL,
  status TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS workflow_runs_workflow ON workflow_runs(workflow_id, created_at);
CREATE INDEX IF NOT EXISTS workflow_runs_status ON workflow_runs(status);
CREATE TABLE IF NOT EXISTS workflow_step_runs (
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (run_id, step_id)
);
CREATE INDEX IF NOT EXISTS workflow_step_runs_order ON workflow_step_runs(run_id, seq);
`;

export const WORKFLOW_RUNS_KEPT = 2_000;

type RunHeader = Omit<WorkflowRun, "stepRuns">;
type StepHeader = Pick<WorkflowRun, "runId" | "updatedAt" | "currentStepId" | "status">;

export function openWorkflowStore(dataDir: string) {
  const file = dataDir === ":memory:" ? ":memory:" : join(dataDir, "workflows.db");
  if (file !== ":memory:") {
    mkdirSync(dirname(file), { recursive: true });
    closeSync(openSync(file, "a", 0o600));
    chmodSync(file, 0o600);
  }
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  const rows = {
    allWorkflows: db.prepare("SELECT json FROM workflows ORDER BY updated_at DESC, id"),
    getWorkflow: db.prepare("SELECT json FROM workflows WHERE id = ?"),
    putWorkflow: db.prepare("INSERT INTO workflows (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at"),
    deleteWorkflow: db.prepare("DELETE FROM workflows WHERE id = ?"),
    getCreator: db.prepare("SELECT creator FROM workflow_creators WHERE workflow_id = ?"),
    putCreator: db.prepare("INSERT INTO workflow_creators (workflow_id, creator) VALUES (?, ?) ON CONFLICT(workflow_id) DO UPDATE SET creator = excluded.creator"),
    deleteCreator: db.prepare("DELETE FROM workflow_creators WHERE workflow_id = ?"),
    getRun: db.prepare("SELECT json FROM workflow_runs WHERE run_id = ?"),
    runsOf: db.prepare("SELECT json FROM workflow_runs WHERE workflow_id = ? ORDER BY created_at DESC, run_id LIMIT ?"),
    activeRuns: db.prepare("SELECT json FROM workflow_runs WHERE status = 'active' ORDER BY created_at, run_id"),
    putRun: db.prepare("INSERT INTO workflow_runs (run_id, workflow_id, routine_id, status, json, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET status = excluded.status, json = excluded.json"),
    updateRun: db.prepare("UPDATE workflow_runs SET status = ?, json = ? WHERE run_id = ?"),
    stepsOf: db.prepare("SELECT json FROM workflow_step_runs WHERE run_id = ? ORDER BY seq"),
    getStep: db.prepare("SELECT seq FROM workflow_step_runs WHERE run_id = ? AND step_id = ?"),
    maxSeq: db.prepare("SELECT COALESCE(MAX(seq), -1) AS seq FROM workflow_step_runs WHERE run_id = ?"),
    putStep: db.prepare("INSERT INTO workflow_step_runs (run_id, step_id, seq, status, json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id, step_id) DO UPDATE SET status = excluded.status, json = excluded.json"),
    deleteSteps: db.prepare("DELETE FROM workflow_step_runs WHERE run_id = ?"),
    finishedBeyond: db.prepare("SELECT run_id FROM workflow_runs WHERE status != 'active' ORDER BY created_at DESC, run_id LIMIT -1 OFFSET ?"),
    deleteRun: db.prepare("DELETE FROM workflow_runs WHERE run_id = ?"),
  };
  const jsonOf = (row: unknown): string => (row as { json: string }).json;
  const transaction = <T>(run: () => T): T => {
    db.exec("BEGIN");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const readRun = (row: unknown): WorkflowRun => {
    const header = JSON.parse(jsonOf(row)) as RunHeader;
    const stepRuns = rows.stepsOf.all(header.runId).map((step) => ({ ...(JSON.parse(jsonOf(step)) as WorkflowStepRun) }));
    return { ...header, stepRuns };
  };
  const writeStep = (runId: string, step: WorkflowStepRun) => {
    const existing = rows.getStep.get(runId, step.stepId) as { seq: number } | undefined;
    const seq = existing ? existing.seq : (rows.maxSeq.get(runId) as { seq: number }).seq + 1;
    rows.putStep.run(runId, step.stepId, seq, step.status, JSON.stringify(step));
  };
  return {
    listWorkflows(): Workflow[] {
      return rows.allWorkflows.all().map((row) => JSON.parse(jsonOf(row)) as Workflow);
    },
    workflow(id: string): Workflow | null {
      const row = rows.getWorkflow.get(id);
      return row ? (JSON.parse(jsonOf(row)) as Workflow) : null;
    },
    putWorkflow(workflow: Workflow): void {
      rows.putWorkflow.run(workflow.id, JSON.stringify(workflow), workflow.updatedAt);
    },
    creator(id: string): string | undefined {
      const row = rows.getCreator.get(id) as { creator: string } | undefined;
      return row?.creator;
    },
    putCreator(id: string, creator: string): void {
      rows.putCreator.run(id, creator);
    },
    deleteWorkflow(id: string): boolean {
      rows.deleteCreator.run(id);
      return Number(rows.deleteWorkflow.run(id).changes) > 0;
    },
    run(runId: string): WorkflowRun | null {
      const row = rows.getRun.get(runId);
      return row ? readRun(row) : null;
    },
    runsOf(workflowId: string, limit: number): WorkflowRun[] {
      return rows.runsOf.all(workflowId, limit).map(readRun);
    },
    activeRuns(): WorkflowRun[] {
      return rows.activeRuns.all().map(readRun);
    },
    /** The header and every step run, in one transaction. */
    putRun(run: WorkflowRun): void {
      const { stepRuns, ...header } = run;
      transaction(() => {
        rows.putRun.run(run.runId, run.workflowId, run.routineId, run.status, JSON.stringify(header), run.createdAt);
        rows.deleteSteps.run(run.runId);
        stepRuns.forEach((step, seq) => rows.putStep.run(run.runId, step.stepId, seq, step.status, JSON.stringify(step)));
      });
    },
    /** One step run, and the header's `updatedAt`, `currentStepId` and `status`, in one transaction. */
    putStep(run: StepHeader, step: WorkflowStepRun): void {
      transaction(() => {
        const row = rows.getRun.get(run.runId);
        if (!row) return;
        const header = JSON.parse(jsonOf(row)) as RunHeader;
        header.updatedAt = run.updatedAt;
        header.status = run.status as WorkflowRunStatus;
        if (run.currentStepId === undefined) delete header.currentStepId;
        else header.currentStepId = run.currentStepId;
        rows.updateRun.run(header.status, JSON.stringify(header), run.runId);
        writeStep(run.runId, step);
      });
    },
    /** Drops finished runs beyond the newest `keep`, with their step runs. */
    prune(keep = WORKFLOW_RUNS_KEPT): number {
      return transaction(() => {
        const old = rows.finishedBeyond.all(keep) as Array<{ run_id: string }>;
        for (const { run_id } of old) {
          rows.deleteSteps.run(run_id);
          rows.deleteRun.run(run_id);
        }
        return old.length;
      });
    },
    close(): void {
      db.close();
    },
  };
}

export type WorkflowStore = ReturnType<typeof openWorkflowStore>;
