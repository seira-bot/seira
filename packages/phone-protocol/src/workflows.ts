import { ROUTINE_GOAL_RUN_LIMIT_MINUTES, type RoutineAccess } from "./routines.ts";
import type { ModelSelection } from "./wire.ts";

export const WORKFLOW_LIMITS = {
  steps: 50, connections: 100, name: 80, instruction: 20_000, question: 2_000, note: 2_000, waitMinutes: 43_200,
} as const;
/** A workflow run stops after this much work; its waits do not count. */
export const WORKFLOW_RUN_LIMIT_MINUTES = ROUTINE_GOAL_RUN_LIMIT_MINUTES;
export const WORKFLOW_STEP_OUTPUT_CHARS = 20_000;
/** A `workflow.run` frame carries at most this much of each step's output; the full output is read from the run. */
export const WORKFLOW_FRAME_OUTPUT_CHARS = 300;

export interface WorkflowPosition { x: number; y: number }
export interface WorkflowStepBase { id: string; position: WorkflowPosition }
export type WorkflowStep =
  /** `modelSelection` and `access` override the routine's own for this step only. */
  | (WorkflowStepBase & { kind: "bot"; botId: string; instruction: string; modelSelection?: ModelSelection; access?: RoutineAccess })
  | (WorkflowStepBase & { kind: "check"; question: string })
  | (WorkflowStepBase & { kind: "wait"; minutes: number })
  | (WorkflowStepBase & { kind: "post" })
  | (WorkflowStepBase & { kind: "note"; text: string });
export type WorkflowStepKind = WorkflowStep["kind"];
export type WorkflowBranch = "yes" | "no";
/** `branch` only on a connection out of an AI check. */
export interface WorkflowConnection { id: string; from: string; to: string; branch?: WorkflowBranch }
export interface WorkflowGraph { steps: WorkflowStep[]; connections: WorkflowConnection[] }
/** `manual`: it runs only when a person starts it, so it has no start on purpose. */
export interface Workflow extends WorkflowGraph { id: string; name: string; manual?: boolean; createdAt: number; updatedAt: number }
/** `ifUpdatedAt`: refuse the change when the saved workflow is newer (another window changed it). */
export interface WorkflowInput extends WorkflowGraph { name: string; manual?: boolean; ifUpdatedAt?: number }
/** A workflow drawn from a finished reply, not saved yet. `omitted`: steps left out because the person may not use
 * their bot. `trimmed`: steps past the step limit. */
export interface DrawnWorkflow { draft: WorkflowInput; omitted: number; trimmed: number }

export type WorkflowProblemCode =
  | "workflow_shape" | "workflow_name" | "workflow_too_big" | "workflow_duplicate_id" | "workflow_unknown_step"
  | "workflow_loop" | "workflow_note_connected" | "workflow_branch_not_check" | "workflow_branch_missing"
  | "workflow_duplicate_branch" | "workflow_too_many_outgoing" | "workflow_bot_missing"
  | "workflow_instruction_missing" | "workflow_question_missing" | "workflow_wait_range" | "workflow_text_too_long"
  | "workflow_no_start" | "workflow_many_starts" | "workflow_start_not_bot" | "workflow_changed";
export interface WorkflowProblem { code: WorkflowProblemCode; stepId?: string; connectionId?: string; message: string }

export type WorkflowStepStatus = "waiting" | "running" | "done" | "failed" | "skipped" | "not_run";
export type WorkflowStepErrorCode =
  | "bot_missing" | "bot_busy_too_long" | "turn_failed" | "needs_person" | "check_unclear" | "restart_cut" | "run_stopped" | "run_limit";
export interface WorkflowStepRun {
  stepId: string;
  status: WorkflowStepStatus;
  botId?: string;
  threadId?: string;
  /** Redacted, at most WORKFLOW_STEP_OUTPUT_CHARS. A check and a wait pass on the output they received. */
  output?: string;
  outputClipped?: true;
  answer?: WorkflowBranch;
  error?: string;
  errorCode?: WorkflowStepErrorCode;
  waitingFor?: "time" | "bot" | "person";
  resumeAt?: number;
  /** The step whose output this step received. */
  fromStepId?: string;
  /** Copied from an earlier run by "Run again from here". */
  carried?: true;
  attempts?: number;
  busySince?: number;
  startedAt?: number;
  finishedAt?: number;
}
export type WorkflowRunStartKind = "schedule" | "manual" | "webhook" | "app";
/** The start that fired a run: `id` is the routine, webhook or app trigger. */
export interface WorkflowRunStart { kind: WorkflowRunStartKind; id: string }
export type WorkflowRunStatus = "active" | "completed" | "failed" | "stopped";
export interface WorkflowRun {
  /** The id of the routine run it belongs to. */
  runId: string;
  workflowId: string;
  routineId: string;
  workflowName: string;
  status: WorkflowRunStatus;
  /** The graph as it was when the run started. */
  graph: WorkflowGraph;
  botIds: string[];
  startStepId: string;
  currentStepId?: string;
  fromRunId?: string;
  /** The start that fired the run. Absent on a run made before starts were kept. */
  start?: WorkflowRunStart;
  /** The text of the event that fired the run. The first step receives it as its input. */
  event?: string;
  /** What the start step receives on "Run again from here". */
  input?: { fromStepId: string; output: string };
  /** One chat per bot per run: bot id to thread id. */
  threads: Record<string, string>;
  stepRuns: WorkflowStepRun[];
  createdAt: number;
  updatedAt: number;
}
export type WorkflowRunUpdate = Omit<WorkflowRun, "graph">;
export type WorkflowFrame =
  | { kind: "workflow"; workflow: Workflow }
  | { kind: "workflow.deleted"; workflowId: string }
  | { kind: "workflow.run"; run: WorkflowRunUpdate };
