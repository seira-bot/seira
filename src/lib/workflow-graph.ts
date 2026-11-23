import {
  WORKFLOW_LIMITS,
  type WorkflowBranch,
  type WorkflowConnection,
  type WorkflowGraph,
  type WorkflowProblemCode,
  type WorkflowStep,
  type WorkflowStepKind,
} from "../../shared/workflows";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { ApiError } from "@/state/api";

export interface ClientProblem { code: WorkflowProblemCode; stepId?: string; connectionId?: string }
export type ConnectRefusal = "self" | "note" | "loop";
export type WorkflowDraftLike = WorkflowGraph & { name: string };
export type WaitUnit = "minutes" | "hours" | "days";

const TITLE_CHARS = 60;

export const KIND_LABEL: Record<WorkflowStepKind, LocaleKey> = {
  bot: "workflow.kind.bot",
  check: "workflow.kind.check",
  wait: "workflow.kind.wait",
  post: "workflow.kind.post",
  note: "workflow.kind.note",
};

export const PROBLEM_TEXT: Record<WorkflowProblemCode, LocaleKey> = {
  workflow_shape: "workflow.problem.shape",
  workflow_duplicate_id: "workflow.problem.shape",
  workflow_unknown_step: "workflow.problem.shape",
  workflow_name: "workflow.problem.name",
  workflow_too_big: "workflow.problem.tooBig",
  workflow_loop: "workflow.problem.loop",
  workflow_note_connected: "workflow.problem.noteConnected",
  workflow_branch_not_check: "workflow.problem.branchNotCheck",
  workflow_branch_missing: "workflow.problem.branchMissing",
  workflow_duplicate_branch: "workflow.problem.duplicateBranch",
  workflow_too_many_outgoing: "workflow.problem.tooManyOutgoing",
  workflow_bot_missing: "workflow.problem.botMissing",
  workflow_instruction_missing: "workflow.problem.instructionMissing",
  workflow_question_missing: "workflow.problem.questionMissing",
  workflow_wait_range: "workflow.problem.waitRange",
  workflow_text_too_long: "workflow.problem.textTooLong",
  workflow_no_start: "workflow.problem.noStart",
  workflow_many_starts: "workflow.problem.manyStarts",
  workflow_start_not_bot: "workflow.problem.startNotBot",
  workflow_changed: "workflow.problem.changed",
};

const runnable = (step: WorkflowStep): boolean => step.kind !== "note";

export const stepById = (graph: WorkflowGraph, id: string): WorkflowStep | undefined => graph.steps.find((step) => step.id === id);

const branchRank = (connection: WorkflowConnection): number => (connection.branch === "yes" ? 0 : connection.branch === "no" ? 1 : 2);

/** Yes before No, then the rest in the order saved. */
export function outgoing(graph: WorkflowGraph, stepId: string): WorkflowConnection[] {
  return graph.connections
    .map((connection, index) => ({ connection, index }))
    .filter(({ connection }) => connection.from === stepId)
    .sort((a, b) => branchRank(a.connection) - branchRank(b.connection) || a.index - b.index)
    .map(({ connection }) => connection);
}

export function startSteps(graph: WorkflowGraph): WorkflowStep[] {
  const entered = new Set(graph.connections.map((connection) => connection.to));
  return graph.steps.filter((step) => runnable(step) && !entered.has(step.id));
}

/** The connection that closes the first loop found, or null. Only connections between two runnable steps count. */
export function findLoop(graph: WorkflowGraph): WorkflowConnection | null {
  const ids = new Set(graph.steps.filter(runnable).map((step) => step.id));
  const state = new Map<string, "open" | "closed">();
  const visit = (id: string): WorkflowConnection | null => {
    state.set(id, "open");
    for (const connection of outgoing(graph, id)) {
      if (!ids.has(connection.to)) continue;
      const seen = state.get(connection.to);
      if (seen === "open") return connection;
      if (!seen) {
        const found = visit(connection.to);
        if (found) return found;
      }
    }
    state.set(id, "closed");
    return null;
  };
  for (const step of graph.steps) {
    if (!ids.has(step.id) || state.has(step.id)) continue;
    const found = visit(step.id);
    if (found) return found;
  }
  return null;
}

/** From each start step, Yes before No, each runnable step once. */
export function stepOrder(graph: WorkflowGraph): WorkflowStep[] {
  const order: WorkflowStep[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    const step = stepById(graph, id);
    if (!step || !runnable(step) || seen.has(id)) return;
    seen.add(id);
    order.push(step);
    for (const connection of outgoing(graph, id)) visit(connection.to);
  };
  for (const start of startSteps(graph)) visit(start.id);
  return order;
}

/** The order a keyboard visits the steps: the flow first, then the rest from top to bottom and left to right. */
export function readingOrder(graph: WorkflowGraph): WorkflowStep[] {
  const flow = stepOrder(graph);
  const inFlow = new Set(flow.map((step) => step.id));
  const loose = graph.steps.filter((step) => !inFlow.has(step.id)).sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
  return [...flow, ...loose];
}

export function botIdsOf(graph: WorkflowGraph): string[] {
  const ids: string[] = [];
  for (const step of stepOrder(graph)) if (step.kind === "bot" && !ids.includes(step.botId)) ids.push(step.botId);
  return ids;
}

export function saveProblems(input: WorkflowDraftLike, botExists: (botId: string) => boolean): ClientProblem[] {
  const problems: ClientProblem[] = [];
  const add = (code: WorkflowProblemCode, where: { stepId?: string; connectionId?: string } = {}) => { problems.push({ code, ...where }); };
  const name = input.name.trim();

  if (!name || name.length > WORKFLOW_LIMITS.name) add("workflow_name");
  if (input.steps.length > WORKFLOW_LIMITS.steps || input.connections.length > WORKFLOW_LIMITS.connections) {
    add("workflow_too_big");
    return problems;
  }

  const seenSteps = new Set<string>();
  for (const step of input.steps) {
    if (seenSteps.has(step.id)) add("workflow_duplicate_id", { stepId: step.id });
    seenSteps.add(step.id);
  }
  const seenConnections = new Set<string>();
  for (const connection of input.connections) {
    if (seenConnections.has(connection.id)) add("workflow_duplicate_id", { connectionId: connection.id });
    seenConnections.add(connection.id);
  }

  for (const step of input.steps) {
    if (step.kind === "bot" && !botExists(step.botId)) add("workflow_bot_missing", { stepId: step.id });
  }
  for (const step of input.steps) {
    if (step.kind === "bot" && !step.instruction.trim()) add("workflow_instruction_missing", { stepId: step.id });
  }
  for (const step of input.steps) {
    if (step.kind === "check" && !step.question.trim()) add("workflow_question_missing", { stepId: step.id });
  }
  for (const step of input.steps) {
    if (step.kind === "wait" && !(Number.isInteger(step.minutes) && step.minutes >= 1 && step.minutes <= WORKFLOW_LIMITS.waitMinutes)) {
      add("workflow_wait_range", { stepId: step.id });
    }
  }
  for (const step of input.steps) {
    const tooLong = step.kind === "bot" ? step.instruction.length > WORKFLOW_LIMITS.instruction
      : step.kind === "check" ? step.question.length > WORKFLOW_LIMITS.question
      : step.kind === "note" ? step.text.length > WORKFLOW_LIMITS.note
      : false;
    if (tooLong) add("workflow_text_too_long", { stepId: step.id });
  }

  const known: WorkflowConnection[] = [];
  for (const connection of input.connections) {
    if (stepById(input, connection.from) && stepById(input, connection.to)) known.push(connection);
    else add("workflow_unknown_step", { connectionId: connection.id });
  }
  const joined: WorkflowConnection[] = [];
  for (const connection of known) {
    const ends = [stepById(input, connection.from)!, stepById(input, connection.to)!];
    const note = ends.find((end) => end.kind === "note");
    if (note) add("workflow_note_connected", { stepId: note.id, connectionId: connection.id });
    else joined.push(connection);
  }
  for (const connection of joined) {
    const from = stepById(input, connection.from)!;
    if (from.kind !== "check" && connection.branch) add("workflow_branch_not_check", { stepId: from.id, connectionId: connection.id });
  }
  for (const connection of joined) {
    const from = stepById(input, connection.from)!;
    if (from.kind === "check" && !connection.branch) add("workflow_branch_missing", { stepId: from.id, connectionId: connection.id });
  }
  const branches = new Set<string>();
  for (const connection of joined) {
    const from = stepById(input, connection.from)!;
    if (from.kind !== "check" || !connection.branch) continue;
    const key = `${from.id}:${connection.branch}`;
    if (branches.has(key)) add("workflow_duplicate_branch", { stepId: from.id, connectionId: connection.id });
    branches.add(key);
  }
  for (const step of input.steps) {
    if (step.kind === "check" || step.kind === "note") continue;
    if (joined.filter((connection) => connection.from === step.id).length > 1) add("workflow_too_many_outgoing", { stepId: step.id });
  }
  const loop = findLoop({ steps: input.steps, connections: joined });
  if (loop) add("workflow_loop", { stepId: loop.from, connectionId: loop.id });
  return problems;
}

export function runnableProblem(graph: WorkflowGraph, botExists: (botId: string) => boolean): ClientProblem | null {
  const starts = startSteps(graph);
  if (starts.length === 0) return { code: "workflow_no_start" };
  if (starts.length > 1) return { code: "workflow_many_starts", stepId: starts[1]!.id };
  const start = starts[0]!;
  if (start.kind !== "bot") return { code: "workflow_start_not_bot", stepId: start.id };
  for (const step of stepOrder(graph)) {
    if (step.kind === "bot" && !botExists(step.botId)) return { code: "workflow_bot_missing", stepId: step.id };
  }
  return null;
}

/** `branch` names the slot of a check; the connection now in that slot would be replaced, so it does not count. */
export function connectRefusal(graph: WorkflowGraph, from: string, to: string, branch?: WorkflowBranch): ConnectRefusal | null {
  if (from === to) return "self";
  const source = stepById(graph, from);
  const target = stepById(graph, to);
  if (!source || !target) return null;
  if (source.kind === "note" || target.kind === "note") return "note";
  const kept = graph.connections.filter((connection) => {
    if (connection.from !== from) return true;
    if (source.kind === "check") return branch === undefined || connection.branch !== branch;
    return false;
  });
  return findLoop({ steps: graph.steps, connections: [...kept, { id: "new-connection", from, to, ...(branch ? { branch } : {}) }] }) ? "loop" : null;
}

export function waitParts(minutes: number): { amount: number; unit: WaitUnit } {
  if (minutes > 0 && minutes % 1440 === 0) return { amount: minutes / 1440, unit: "days" };
  if (minutes > 0 && minutes % 60 === 0) return { amount: minutes / 60, unit: "hours" };
  return { amount: minutes, unit: "minutes" };
}

export function waitMinutes(amount: number, unit: WaitUnit): number {
  return amount * (unit === "days" ? 1440 : unit === "hours" ? 60 : 1);
}

export function waitText(minutes: number): string {
  const { amount, unit } = waitParts(minutes);
  return t(`workflow.wait.${unit}.${amount === 1 ? "one" : "other"}` as const, { count: amount });
}

export function stepsText(count: number): string {
  return t(count === 1 ? "workflow.steps.one" : "workflow.steps.other", { count });
}

const firstLine = (text: string): string => text.split("\n").find((line) => line.trim())?.trim() ?? "";

export function stepTitle(step: WorkflowStep, botName: (botId: string) => string | undefined): string {
  switch (step.kind) {
    case "bot": return botName(step.botId) ?? t("workflow.step.noBot");
    case "check": {
      const question = step.question.trim();
      if (!question) return t("workflow.step.noQuestion");
      return question.length > TITLE_CHARS ? `${question.slice(0, TITLE_CHARS)}…` : question;
    }
    case "wait": return t("workflow.step.waitTitle", { duration: waitText(step.minutes) });
    case "post": return t("workflow.step.postTitle");
    case "note": return firstLine(step.text) || t("workflow.step.emptyNote");
  }
}

export function problemText(problem: ClientProblem, graph: WorkflowGraph & { name?: string }, botName: (botId: string) => string | undefined): string {
  const step = problem.stepId ? stepById(graph, problem.stepId) : undefined;
  const label = step ? (step.kind === "bot" ? stepTitle(step, botName) : t(KIND_LABEL[step.kind])) : t(KIND_LABEL.bot);
  const key = problem.code === "workflow_name" && graph.name !== undefined && !graph.name.trim() ? "workflow.problem.nameEmpty" : PROBLEM_TEXT[problem.code];
  return t(key, {
    step: label,
    max: WORKFLOW_LIMITS.name,
    steps: WORKFLOW_LIMITS.steps,
    connections: WORKFLOW_LIMITS.connections,
  });
}

const isProblemCode = (value: unknown): value is WorkflowProblemCode => typeof value === "string" && Object.hasOwn(PROBLEM_TEXT, value);

export function serverProblems(error: unknown): ClientProblem[] {
  if (!(error instanceof ApiError) || !error.body) return [];
  const { problems, code, stepId, connectionId } = error.body;
  const pick = (value: unknown): ClientProblem | null => {
    if (typeof value !== "object" || value === null) return null;
    const item = value as Record<string, unknown>;
    if (!isProblemCode(item.code)) return null;
    return {
      code: item.code,
      ...(typeof item.stepId === "string" ? { stepId: item.stepId } : {}),
      ...(typeof item.connectionId === "string" ? { connectionId: item.connectionId } : {}),
    };
  };
  if (Array.isArray(problems)) {
    const list = problems.map(pick).filter((problem): problem is ClientProblem => problem !== null);
    if (list.length) return list;
  }
  const single = pick({ code, stepId, connectionId });
  return single ? [single] : [];
}
