import { randomUUID } from "node:crypto";

import { WORKFLOW_LIMITS, type Workflow, type WorkflowConnection, type WorkflowInput, type WorkflowStep } from "../../shared/workflows.ts";
import { redactSecretsInText } from "../redact.ts";
import { stepOrder } from "./graph.ts";

const ROW_STEP = 160;
const INSTRUCTION_SHOWN = 2_000;
const WORKFLOWS_SHOWN = 50;

export const TEAM_WORKFLOW_REFUSAL = "In a Team Cloud, people draw and link workflows themselves under Automations → Workflows.";

export interface AgentWorkflowFacts {
  /** The bot whose turn asks. */
  botId: string;
  /** A bot's name when this bot may know it; undefined for any other. */
  botName(botId: string): string | undefined;
  /** The routines this bot may see (the same rule as trigger_info list). */
  routines: readonly { id: string; name: string; botId: string; workflowId?: string }[];
}

function agentStep(step: WorkflowStep, facts: AgentWorkflowFacts, hideQuestion: boolean) {
  switch (step.kind) {
    case "bot": {
      const own = step.botId === facts.botId;
      const name = facts.botName(step.botId) ?? (own ? "this bot" : "another bot");
      const instruction = redactSecretsInText(step.instruction);
      return {
        kind: "bot" as const,
        bot: name,
        ...(own ? { yours: true, instruction: instruction.slice(0, INSTRUCTION_SHOWN), ...(instruction.length > INSTRUCTION_SHOWN ? { instructionTruncated: true } : {}) } : {}),
      };
    }
    case "check":
      return { kind: "check" as const, ...(hideQuestion ? {} : { question: redactSecretsInText(step.question).slice(0, INSTRUCTION_SHOWN) }) };
    case "wait":
      return { kind: "wait" as const, minutes: step.minutes };
    case "post":
      return { kind: "post" as const };
    default:
      return { kind: "note" as const };
  }
}

/** The saved workflows that use this bot as a step: its own instructions in full, other bots' steps by name only. */
export function agentWorkflows(workflows: readonly Workflow[], facts: AgentWorkflowFacts) {
  return workflows
    .filter((workflow) => workflow.steps.some((step) => step.kind === "bot" && step.botId === facts.botId))
    .slice(0, WORKFLOWS_SHOWN)
    .map((workflow) => {
      const order = stepOrder(workflow);
      const hideQuestion = workflow.steps.some((step) => step.kind === "bot" && step.botId !== facts.botId && facts.botName(step.botId) === undefined);
      const notes = workflow.steps.filter((step) => step.kind === "note");
      return {
        id: workflow.id,
        name: redactSecretsInText(workflow.name),
        stepCount: workflow.steps.length,
        steps: [...order, ...notes].map((step) => agentStep(step, facts, hideQuestion)),
        routines: facts.routines
          .filter((routine) => routine.workflowId === workflow.id && routine.botId === facts.botId)
          .map((routine) => ({ id: routine.id, name: redactSecretsInText(routine.name) })),
      };
    });
}

type Parsed = { ok: true; input: WorkflowInput } | { ok: false; error: string };

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (error: string): Parsed => ({ ok: false, error });

const STEP_KINDS = "bot (instruction, optional bot_id), check (question), wait (minutes) or post";

/** An ordered list of steps as a bot writes it, as the graph the editor draws: one step under the other, each joined to the next.
 *  An AI check passes only its Yes answer on; a No answer ends the workflow. */
export function sequentialWorkflow(
  args: { name?: unknown; steps?: unknown },
  botId: string,
  newId: (prefix: "s" | "c") => string = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`,
): Parsed {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) return fail("workflow action=create needs a name.");
  if (!Array.isArray(args.steps) || args.steps.length === 0) return fail("workflow action=create needs steps: a list in the order they run.");
  if (args.steps.length > WORKFLOW_LIMITS.steps) return fail(`A workflow can have ${WORKFLOW_LIMITS.steps} steps at most.`);
  const steps: WorkflowStep[] = [];
  for (const [index, raw] of args.steps.entries()) {
    const at = `Step ${index + 1}`;
    if (!record(raw)) return fail(`${at} must be an object with a kind: ${STEP_KINDS}.`);
    const base = { id: newId("s"), position: { x: 0, y: index * ROW_STEP } };
    if (raw.kind === "bot") {
      const instruction = typeof raw.instruction === "string" ? raw.instruction.trim() : "";
      if (!instruction) return fail(`${at}: a bot step needs an instruction.`);
      const bot = raw.bot_id === undefined || raw.bot_id === null || raw.bot_id === "" ? botId : raw.bot_id;
      if (typeof bot !== "string") return fail(`${at}: bot_id must be a bot id from list_bots.`);
      steps.push({ ...base, kind: "bot", botId: bot.trim(), instruction });
    } else if (raw.kind === "check") {
      const question = typeof raw.question === "string" ? raw.question.trim() : "";
      if (!question) return fail(`${at}: a check needs a question that the answer yes or no settles.`);
      steps.push({ ...base, kind: "check", question });
    } else if (raw.kind === "wait") {
      if (typeof raw.minutes !== "number" || !Number.isInteger(raw.minutes)) return fail(`${at}: a wait needs minutes as a whole number.`);
      steps.push({ ...base, kind: "wait", minutes: raw.minutes });
    } else if (raw.kind === "post") {
      steps.push({ ...base, kind: "post" });
    } else {
      return fail(`${at}: kind must be ${STEP_KINDS}.`);
    }
  }
  const connections: WorkflowConnection[] = steps.slice(1).map((step, index) => {
    const from = steps[index]!;
    return { id: newId("c"), from: from.id, to: step.id, ...(from.kind === "check" ? { branch: "yes" as const } : {}) };
  });
  return { ok: true, input: { name, steps, connections } };
}
