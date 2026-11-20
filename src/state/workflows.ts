import { useEffect, useSyncExternalStore } from "react";

import type { Workflow, WorkflowGraph, WorkflowInput, WorkflowRun, WorkflowRunUpdate, WorkflowStepRun } from "../../shared/workflows";
import type { ServerFrame } from "../../shared/wire";
import { listenLiveFrames } from "@/lib/live-events";
import type { RoutineRun } from "@/lib/routines";
import { api, ApiError } from "@/state/store";

export interface WorkflowsState {
  loaded: boolean;
  /** The list answered 404 or 503: the Workflows view and the routine slot stay hidden. */
  unavailable: boolean;
  /** The last list load failed on the network. */
  failed: boolean;
  workflows: Workflow[];
  /** Run updates by routine run id, from frames and run lists. */
  runs: Record<string, WorkflowRunUpdate>;
  /** Full runs with their graph, by routine run id. */
  details: Record<string, WorkflowRun>;
}
export type WorkflowDraft = WorkflowGraph & { name: string };
/** `base` is the `updatedAt` of the saved workflow that `draft` was made from. */
export interface KeptDraft { draft: WorkflowDraft; base: number }

const EMPTY: WorkflowsState = { loaded: false, unavailable: false, failed: false, workflows: [], runs: {}, details: {} };
const MAX_RUNS = 200;
const MAX_DETAILS = 20;
const RUNS_LIMIT = 20;
const LOAD_RETRIES = 3;
const LOAD_RETRY_MS = 3000;

let state = EMPTY;
const listeners = new Set<() => void>();
let stopListening: (() => void) | null = null;
let started = false;
let loading: Promise<void> | null = null;
const runLoads = new Map<string, Promise<WorkflowRun | null>>();
const drafts = new Map<string, KeptDraft>();
let changes = 0;
const changedAt = new Map<string, number>();
const removed = new Set<string>();

function set(next: WorkflowsState): void {
  state = next;
  for (const listener of listeners) listener();
}

const withoutGraph = ({ graph: _graph, ...update }: WorkflowRun): WorkflowRunUpdate => update;

function newest<T extends { updatedAt: number }>(record: Record<string, T>, keep: number): Record<string, T> {
  const entries = Object.entries(record);
  if (entries.length <= keep) return record;
  return Object.fromEntries(entries.sort(([, a], [, b]) => b.updatedAt - a.updatedAt).slice(0, keep));
}

/** A frame carries a clipped copy of a long output: keep the full one the run already has for the same finished step. */
function mergeStepRuns(old: readonly WorkflowStepRun[], next: readonly WorkflowStepRun[]): WorkflowStepRun[] {
  return next.map((stepRun) => {
    if (!stepRun.outputClipped) return stepRun;
    const earlier = old.find((candidate) => candidate.stepId === stepRun.stepId);
    if (!earlier || earlier.outputClipped || earlier.output === undefined || earlier.finishedAt !== stepRun.finishedAt) return stepRun;
    const { outputClipped: _clipped, ...rest } = stepRun;
    return { ...rest, output: earlier.output };
  });
}

function putRun(run: WorkflowRunUpdate): void {
  const known = state.runs[run.runId];
  if (known && known.updatedAt > run.updatedAt) return;
  const detail = state.details[run.runId];
  set({
    ...state,
    runs: newest({ ...state.runs, [run.runId]: run }, MAX_RUNS),
    details: detail ? { ...state.details, [run.runId]: { ...detail, ...run, graph: detail.graph, stepRuns: mergeStepRuns(detail.stepRuns, run.stepRuns) } } : state.details,
  });
}

export function applyWorkflowFrame(frame: ServerFrame): void {
  if (frame.kind === "workflow") {
    const incoming = frame.workflow;
    if (removed.has(incoming.id)) return;
    const known = state.workflows.find((workflow) => workflow.id === incoming.id);
    if (!known) set({ ...state, workflows: [incoming, ...state.workflows] });
    else if (incoming.updatedAt >= known.updatedAt) set({ ...state, workflows: state.workflows.map((workflow) => workflow.id === incoming.id ? incoming : workflow) });
    else return;
    changedAt.set(incoming.id, ++changes);
  } else if (frame.kind === "workflow.deleted") {
    removed.add(frame.workflowId);
    drafts.delete(frame.workflowId);
    set({ ...state, workflows: state.workflows.filter((workflow) => workflow.id !== frame.workflowId) });
  } else if (frame.kind === "workflow.run") {
    putRun(frame.run);
  }
}

const unreachable = (error: unknown): boolean =>
  error instanceof ApiError && (error.status === 404 || error.status === 503) && error.body?.error !== "asleep";

const starting = (error: unknown): boolean => error instanceof ApiError && error.status === 503 && error.body?.error !== "asleep";

/** The answer, plus what this client created or received after the request began, and not what it deleted. */
function mergeAnswer(answer: Workflow[], since: number): Workflow[] {
  const mine = new Map(state.workflows.map((workflow) => [workflow.id, workflow]));
  const answered = new Set<string>();
  const merged = answer.filter((workflow) => !removed.has(workflow.id)).map((workflow) => {
    answered.add(workflow.id);
    const local = mine.get(workflow.id);
    return local && local.updatedAt > workflow.updatedAt ? local : workflow;
  });
  const newer = state.workflows.filter((workflow) => !answered.has(workflow.id) && (changedAt.get(workflow.id) ?? 0) > since);
  return [...newer, ...merged];
}

async function fetchWorkflows(options: { background?: boolean }): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const since = changes;
    try {
      const body = await api<{ workflows?: Workflow[] }>("/api/workflows", options.background ? { background: true } : undefined);
      set({ ...state, loaded: true, unavailable: false, failed: false, workflows: mergeAnswer(body.workflows ?? [], since) });
      return;
    } catch (error) {
      if (starting(error) && attempt < LOAD_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, LOAD_RETRY_MS));
        continue;
      }
      set(unreachable(error)
        ? { ...state, loaded: true, unavailable: true, failed: false }
        : { ...state, loaded: true, failed: true });
      return;
    }
  }
}

export function loadWorkflows(options: { background?: boolean } = {}): Promise<void> {
  loading ??= fetchWorkflows(options).finally(() => { loading = null; });
  return loading;
}

export async function loadWorkflowRuns(workflowId: string, limit = RUNS_LIMIT): Promise<void> {
  try {
    const body = await api<{ runs?: WorkflowRunUpdate[] }>(`/api/workflows/${encodeURIComponent(workflowId)}/runs?limit=${limit}`);
    for (const run of body.runs ?? []) putRun(run);
  } catch {
    return;
  }
}

export function loadWorkflowRun(runId: string, options: { force?: boolean } = {}): Promise<WorkflowRun | null> {
  const known = state.details[runId];
  if (known && !options.force) return Promise.resolve(known);
  const pending = runLoads.get(runId);
  if (pending && !options.force) return pending;
  const load: Promise<WorkflowRun | null> = api<{ run: WorkflowRun }>(`/api/workflow-runs/${encodeURIComponent(runId)}`)
    .then(({ run }) => {
      const newer = state.runs[run.runId];
      const merged: WorkflowRun = newer && newer.updatedAt > run.updatedAt
        ? { ...newer, graph: run.graph, stepRuns: mergeStepRuns(run.stepRuns, newer.stepRuns) }
        : run;
      set({
        ...state,
        runs: newest({ ...state.runs, [run.runId]: withoutGraph(merged) }, MAX_RUNS),
        details: newest({ ...state.details, [run.runId]: merged }, MAX_DETAILS),
      });
      return merged;
    })
    .catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    })
    .finally(() => { if (runLoads.get(runId) === load) runLoads.delete(runId); });
  runLoads.set(runId, load);
  return load;
}

function start(): void {
  if (started) return;
  started = true;
  stopListening = listenLiveFrames({ onFrame: applyWorkflowFrame, onMissedFrames: () => void loadWorkflows({ background: true }) });
  void loadWorkflows();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reads the shared copy without starting a load. */
export function useWorkflowsUnavailable(): boolean {
  return useSyncExternalStore(subscribe, () => state.unavailable, () => false);
}

export function useWorkflows(): WorkflowsState {
  useEffect(start, []);
  return useSyncExternalStore(subscribe, () => state, () => EMPTY);
}

const time = (run: WorkflowRunUpdate) => run.createdAt;

/** Newest first. */
export function runsOf(snapshot: WorkflowsState, workflowId: string, routineId?: string): WorkflowRunUpdate[] {
  return Object.values(snapshot.runs)
    .filter((run) => run.workflowId === workflowId && (routineId === undefined || run.routineId === routineId))
    .sort((a, b) => time(b) - time(a) || b.updatedAt - a.updatedAt);
}

const put = (workflow: Workflow) => applyWorkflowFrame({ kind: "workflow", workflow });

export const workflowApi = {
  async create(input: WorkflowInput): Promise<Workflow> {
    const { workflow } = await api<{ workflow: Workflow }>("/api/workflows", { method: "POST", body: JSON.stringify(input) });
    put(workflow);
    return workflow;
  },
  async save(id: string, input: WorkflowInput): Promise<Workflow> {
    const body = { name: input.name, steps: input.steps, connections: input.connections, ifUpdatedAt: input.ifUpdatedAt };
    const { workflow } = await api<{ workflow: Workflow }>(`/api/workflows/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
    put(workflow);
    return workflow;
  },
  async remove(id: string): Promise<void> {
    await api(`/api/workflows/${encodeURIComponent(id)}`, { method: "DELETE" });
    applyWorkflowFrame({ kind: "workflow.deleted", workflowId: id });
  },
  async runAgain(runId: string, stepId: string): Promise<RoutineRun> {
    const { run } = await api<{ run: RoutineRun }>(
      `/api/workflow-runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/run-again`,
      { method: "POST" },
    );
    return run;
  },
};

export function keepDraft(workflowId: string, draft: WorkflowDraft, base: number): void {
  drafts.set(workflowId, { draft, base });
}

export function takeDraft(workflowId: string): KeptDraft | undefined {
  const kept = drafts.get(workflowId);
  drafts.delete(workflowId);
  return kept;
}

export function discardDraft(workflowId: string): void {
  drafts.delete(workflowId);
}

export function resetWorkflowsForTest(): void {
  stopListening?.();
  stopListening = null;
  started = false;
  loading = null;
  runLoads.clear();
  drafts.clear();
  changes = 0;
  changedAt.clear();
  removed.clear();
  state = EMPTY;
  listeners.clear();
}
