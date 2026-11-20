import { z } from "zod";

import type { ServerErrorBody } from "../../shared/server-text.ts";
import {
  WORKFLOW_LIMITS,
  type WorkflowConnection,
  type WorkflowGraph,
  type WorkflowInput,
  type WorkflowProblem,
  type WorkflowProblemCode,
  type WorkflowStep,
} from "../../shared/workflows.ts";
import { findLoop, startSteps, stepById, stepLabel, stepOrder } from "./graph.ts";

export interface WorkflowFacts { botName(botId: string): string | undefined }
export type WorkflowCheck = { ok: true; value: WorkflowInput } | { ok: false; problems: WorkflowProblem[] };

const MAX_PROBLEMS = 20;
const SHAPE_MESSAGE = "This workflow could not be saved. Reload it and try again.";

const id = z.string().regex(/^[\w-]{1,64}$/);
const text = z.string().default("");
const base = { id, position: z.object({ x: z.number(), y: z.number() }) };
const stepSchema = z.discriminatedUnion("kind", [
  z.looseObject({ ...base, kind: z.literal("bot"), botId: text, instruction: text }),
  z.looseObject({ ...base, kind: z.literal("check"), question: text }),
  z.looseObject({ ...base, kind: z.literal("wait"), minutes: z.number() }),
  z.looseObject({ ...base, kind: z.literal("post") }),
  z.looseObject({ ...base, kind: z.literal("note"), text }),
]);
const connectionSchema = z.looseObject({ id, from: id, to: id, branch: z.enum(["yes", "no"]).optional() });
const inputSchema = z.object({
  name: z.string(),
  steps: z.array(stepSchema),
  connections: z.array(connectionSchema),
  ifUpdatedAt: z.number().optional(),
});

export function validateWorkflowInput(body: unknown, facts: WorkflowFacts): WorkflowCheck {
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return { ok: false, problems: [{ code: "workflow_shape", message: SHAPE_MESSAGE }] };
  const value: WorkflowInput = { ...parsed.data, name: parsed.data.name.trim() };
  const problems: WorkflowProblem[] = [];
  const add = (code: WorkflowProblemCode, message: string, where: { stepId?: string; connectionId?: string } = {}) => {
    problems.push({ code, ...where, message });
  };
  const label = (step: WorkflowStep) => stepLabel(step, facts.botName);

  if (!value.name) add("workflow_name", "Give the workflow a name.");
  else if (value.name.length > WORKFLOW_LIMITS.name) add("workflow_name", `Use a workflow name of ${WORKFLOW_LIMITS.name} characters or fewer.`);

  if (value.steps.length > WORKFLOW_LIMITS.steps || value.connections.length > WORKFLOW_LIMITS.connections) {
    add("workflow_too_big", `A workflow can have ${WORKFLOW_LIMITS.steps} steps and ${WORKFLOW_LIMITS.connections} connections at most.`);
    return { ok: false, problems };
  }

  const seenSteps = new Set<string>();
  for (const step of value.steps) {
    if (seenSteps.has(step.id)) add("workflow_duplicate_id", SHAPE_MESSAGE, { stepId: step.id });
    seenSteps.add(step.id);
  }
  const seenConnections = new Set<string>();
  for (const connection of value.connections) {
    if (seenConnections.has(connection.id)) add("workflow_duplicate_id", SHAPE_MESSAGE, { connectionId: connection.id });
    seenConnections.add(connection.id);
  }

  for (const step of value.steps) {
    if (step.kind === "bot" && !facts.botName(step.botId)) add("workflow_bot_missing", `${label(step)}: choose a bot for this step.`, { stepId: step.id });
  }
  for (const step of value.steps) {
    if (step.kind === "bot" && !step.instruction.trim()) add("workflow_instruction_missing", `${label(step)}: tell the bot what to do in this step.`, { stepId: step.id });
  }
  for (const step of value.steps) {
    if (step.kind === "check" && !step.question.trim()) add("workflow_question_missing", "AI check: write the yes-or-no question.", { stepId: step.id });
  }
  for (const step of value.steps) {
    if (step.kind === "wait" && !(Number.isInteger(step.minutes) && step.minutes >= 1 && step.minutes <= WORKFLOW_LIMITS.waitMinutes)) {
      add("workflow_wait_range", "Wait: choose 1 minute to 30 days.", { stepId: step.id });
    }
  }
  for (const step of value.steps) {
    const tooLong = step.kind === "bot" ? step.instruction.length > WORKFLOW_LIMITS.instruction
      : step.kind === "check" ? step.question.length > WORKFLOW_LIMITS.question
      : step.kind === "note" ? step.text.length > WORKFLOW_LIMITS.note
      : false;
    if (tooLong) add("workflow_text_too_long", `${label(step)}: this text is too long.`, { stepId: step.id });
  }

  const known: WorkflowConnection[] = [];
  for (const connection of value.connections) {
    if (stepById(value, connection.from) && stepById(value, connection.to)) known.push(connection);
    else add("workflow_unknown_step", SHAPE_MESSAGE, { connectionId: connection.id });
  }
  const joined: WorkflowConnection[] = [];
  for (const connection of known) {
    const ends = [stepById(value, connection.from)!, stepById(value, connection.to)!];
    const note = ends.find((end) => end.kind === "note");
    if (note) add("workflow_note_connected", "Note: a note can't connect to steps.", { stepId: note.id, connectionId: connection.id });
    else joined.push(connection);
  }
  const branches = new Set<string>();
  for (const connection of joined) {
    const from = stepById(value, connection.from)!;
    if (from.kind !== "check" && connection.branch) {
      add("workflow_branch_not_check", `${label(from)}: only an AI check has Yes and No connections.`, { stepId: from.id, connectionId: connection.id });
    }
  }
  for (const connection of joined) {
    const from = stepById(value, connection.from)!;
    if (from.kind === "check" && !connection.branch) add("workflow_branch_missing", "AI check: mark this connection Yes or No.", { stepId: from.id, connectionId: connection.id });
  }
  for (const connection of joined) {
    const from = stepById(value, connection.from)!;
    if (from.kind !== "check" || !connection.branch) continue;
    const key = `${from.id}:${connection.branch}`;
    if (branches.has(key)) add("workflow_duplicate_branch", `AI check: it already has a ${connection.branch === "yes" ? "Yes" : "No"} connection.`, { stepId: from.id, connectionId: connection.id });
    branches.add(key);
  }
  for (const step of value.steps) {
    if (step.kind === "check" || step.kind === "note") continue;
    if (joined.filter((connection) => connection.from === step.id).length > 1) {
      add("workflow_too_many_outgoing", `${label(step)}: a step connects to one next step only.`, { stepId: step.id });
    }
  }
  const loop = findLoop({ steps: value.steps, connections: joined });
  if (loop) {
    add("workflow_loop", `${label(stepById(value, loop.from)!)}: this connection makes a loop. Remove it.`, { stepId: loop.from, connectionId: loop.id });
  }

  return problems.length ? { ok: false, problems } : { ok: true, value };
}

export function runnableProblem(graph: WorkflowGraph, facts: WorkflowFacts): WorkflowProblem | null {
  const starts = startSteps(graph);
  if (starts.length === 0) return { code: "workflow_no_start", message: "Add a bot step to start this workflow." };
  if (starts.length > 1) return { code: "workflow_many_starts", stepId: starts[1]!.id, message: "A workflow starts at one step. Connect the other first steps after it." };
  const start = starts[0]!;
  if (start.kind !== "bot") return { code: "workflow_start_not_bot", stepId: start.id, message: "A workflow starts with a bot step." };
  for (const step of stepOrder(graph)) {
    if (step.kind === "bot" && !facts.botName(step.botId)) {
      return { code: "workflow_bot_missing", stepId: step.id, message: `${stepLabel(step, facts.botName)}: choose a bot for this step.` };
    }
  }
  return null;
}

export function problemBody(problems: WorkflowProblem[]): ServerErrorBody & { stepId?: string; connectionId?: string; problems: WorkflowProblem[] } {
  const first = problems[0];
  return {
    error: first?.message ?? SHAPE_MESSAGE,
    code: first?.code ?? "workflow_shape",
    ...(first?.stepId ? { stepId: first.stepId } : {}),
    ...(first?.connectionId ? { connectionId: first.connectionId } : {}),
    problems: problems.slice(0, MAX_PROBLEMS),
  };
}
