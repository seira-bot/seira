import { PublicError } from "../public-error.ts";
import type { Routine, RoutineInput } from "../routines.ts";
import type { Workflow, WorkflowProblem } from "../../shared/workflows.ts";
import { botIdsOf, outgoing, startSteps, stepById, stepLabel, stepOrder } from "./graph.ts";

export interface WorkflowCopy { workflowId: string; prompt: string; botId: string; botIds: string[] }
/** null: there is no such workflow. A problem: it cannot run yet. */
export type WorkflowCopyLookup = (workflowId: string) => WorkflowCopy | WorkflowProblem | null;

const STEP_TEXT_CHARS = 2_000;
const COPY_CHARS = 20_000;
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function workflowPromptCopy(workflow: Workflow, botName: (botId: string) => string | undefined): string {
  const order = stepOrder(workflow);
  const header = `This routine runs the workflow ${JSON.stringify(workflow.name)}.`;
  if (order.length === 0) return `${header} It has no steps yet.`;
  const numberOf = new Map(order.map((step, index) => [step.id, index + 1]));
  const go = (stepId: string | undefined): string => {
    const number = stepId === undefined ? undefined : numberOf.get(stepId);
    return number === undefined ? "finish" : `go to ${number}`;
  };
  const lines = order.map((step, index) => {
    const next = outgoing(workflow, step.id).find((connection) => stepById(workflow, connection.to));
    const label = stepLabel(step, botName);
    const then = next
      ? numberOf.get(next.to) !== index + 2 ? ` Then ${go(next.to)}.` : ""
      : index + 1 < order.length ? " Then finish." : "";
    switch (step.kind) {
      case "bot":
        return `${index + 1}. ${label}: ${clip(step.instruction.trim(), STEP_TEXT_CHARS)}${then}`;
      case "check": {
        const yes = outgoing(workflow, step.id).find((connection) => connection.branch === "yes");
        const no = outgoing(workflow, step.id).find((connection) => connection.branch === "no");
        return `${index + 1}. ${label}: ${clip(step.question.trim(), STEP_TEXT_CHARS)} If yes, ${go(yes?.to)}. If no, ${go(no?.to)}.`;
      }
      case "wait":
        return `${index + 1}. Wait ${step.minutes} ${step.minutes === 1 ? "minute" : "minutes"}.${then}`;
      default:
        return `${index + 1}. ${label}.${then}`;
    }
  });
  return `${header} Do these steps in order:\n${lines.join("\n")}`.slice(0, COPY_CHARS);
}

export function workflowCopy(workflow: Workflow, botName: (botId: string) => string | undefined): WorkflowCopy {
  const start = startSteps(workflow)[0];
  const botIds = botIdsOf(workflow);
  return {
    workflowId: workflow.id,
    prompt: workflowPromptCopy(workflow, botName),
    botId: start?.kind === "bot" ? start.botId : botIds[0] ?? "",
    botIds,
  };
}

/** The routine fields a linked workflow sets; null when the input names none. Throws a person's words when it cannot be linked. */
export function linkWorkflow(input: Pick<RoutineInput, "workflowId">, lookup: WorkflowCopyLookup | undefined): WorkflowCopy | null {
  if (input.workflowId == null) return null;
  const found = lookup?.(input.workflowId) ?? null;
  if (!found) throw new PublicError("That workflow is gone. Choose another one.", 409);
  if ("code" in found) throw new PublicError(found.message, 409);
  return found;
}

/** The lookup an edit of a routine uses: the copy it already holds, unless the edit names a workflow or asks for a rewrite. */
export function workflowLookupFor(
  patch: { workflowId?: string | null; rewriteWorkflow?: true },
  routine: Pick<Routine, "prompt" | "botId" | "workflowId" | "workflowBotIds">,
  lookup: WorkflowCopyLookup | undefined,
): WorkflowCopyLookup | undefined {
  if (Object.hasOwn(patch, "workflowId") || patch.rewriteWorkflow) return lookup;
  return (workflowId) => (workflowId === routine.workflowId && routine.workflowBotIds
    ? { workflowId, prompt: routine.prompt, botId: routine.botId, botIds: routine.workflowBotIds } : null);
}
