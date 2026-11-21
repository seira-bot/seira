import type { RoutineRequestOperation } from "../../shared/routine-request.ts";
import { redactSecretsInText } from "../redact.ts";
import type { Routine, RoutineManager } from "../routines.ts";
import type { WorkflowCopyLookup } from "./routine-link.ts";

export const LINKED_WORKFLOW_INSTRUCTIONS = "Runs a saved workflow.";
const PROMPT_LIMIT = 20_000;

/** What a request needs to link a routine to a saved workflow. */
export interface RoutineWorkflowLinks {
  copy: WorkflowCopyLookup;
  name(workflowId: string): string | undefined;
  botName(botId: string): string | undefined;
  /** Why a bot may not link workflows here, in words for the bot; null when it may. */
  refusal(): string | null;
  /** Whether the caller may set up automations for that bot (the for_bot_id rule). */
  manages(callerBotId: string, botId: string): boolean;
  /** Whether the person behind this turn may see the workflow. */
  shown(workflowId: string, threadId: string): boolean;
}

export interface WorkflowLinkProblem { message: string; status: number }

/** A routine that runs a workflow takes its instructions from the workflow's steps: the request names the workflow, never
 *  words of its own. Fills in those steps so the card shows what will run, and names what the routine would discard. */
export function workflowLinkProblem(
  operation: RoutineRequestOperation,
  botId: string,
  routines: Pick<RoutineManager, "listRoutines">,
  links: RoutineWorkflowLinks | undefined,
  threadId: string,
): WorkflowLinkProblem | null {
  const owner = operation.forBot?.botId ?? botId;
  const changes = operation.action === "update" ? operation.changes : undefined;
  const asked = operation.action === "create" ? operation.routine.workflowId : changes?.workflowId;
  const current: Routine | undefined = operation.action === "update"
    ? routines.listRoutines().find((routine) => routine.id === operation.routineId && routine.botId === owner)
    : undefined;
  if (current?.workflowId && changes?.instructions !== undefined && changes.workflowId === undefined) {
    const name = links?.name(current.workflowId);
    return {
      message: `This automation runs the workflow ${name ? `“${redactSecretsInText(name)}”` : "you set up under Automations → Workflows"}. Change its steps under Automations → Workflows, or set workflow_id to null to give it instructions again.`,
      status: 409,
    };
  }
  if (asked === null && changes?.instructions === undefined && current?.workflowId) {
    return { message: "To stop running the workflow, give this automation instructions of its own in the same call.", status: 400 };
  }
  if (typeof asked !== "string") return null;
  const refusal = links?.refusal();
  if (refusal) return { message: refusal, status: 403 };
  if (links && !links.shown(asked, threadId)) return { message: "There is no workflow with that id. Call trigger_info with action=workflows to see the ids.", status: 404 };
  const found = links?.copy(asked) ?? null;
  if (!found) return { message: "There is no workflow with that id. Call trigger_info with action=workflows to see the ids.", status: 404 };
  if ("code" in found) return { message: found.message, status: 409 };
  if (found.botId !== owner) {
    const first = links?.botName(found.botId);
    return { message: `A routine that runs this workflow belongs to the bot of its first step${first ? `, ${first}` : ""}. Set it up for that bot${operation.action === "create" ? " with for_bot_id" : ""}.`, status: 409 };
  }
  const blocked = found.botIds.find((id) => id !== owner && id !== botId && !links?.manages(botId, id));
  if (blocked) return { message: `This workflow has a step for ${links?.botName(blocked) ?? "a bot"}, and you may not set up automations for that bot. Link a workflow whose steps are yours or a bot you manage, or tell the person to link it under Automations → Workflows.`, status: 403 };
  if (operation.action === "create") operation.routine.instructions = found.prompt.slice(0, PROMPT_LIMIT);
  else if (changes) changes.instructions = found.prompt.slice(0, PROMPT_LIMIT);
  return null;
}
