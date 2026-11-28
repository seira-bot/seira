import { PublicError } from "../public-error.ts";
import { linkWorkflow, type WorkflowCopyLookup } from "./routine-link.ts";

/** The fields a linked workflow sets on a webhook or app trigger. Throws a person's words when it cannot be linked. */
export function startWorkflowFields(workflowId: string, lookup: WorkflowCopyLookup | undefined): { workflowId: string; prompt: string; botId: string } {
  const copy = linkWorkflow({ workflowId }, lookup)!;
  return { workflowId: copy.workflowId, prompt: copy.prompt, botId: copy.botId };
}

/** Every bot that writes in the steps must be in the room: a result is never posted for a bot that is not there. `inRoom` throws when one is not. */
export function assertWorkflowRoom(lookup: WorkflowCopyLookup | undefined, inRoom: (botId: string, groupId: string) => void, workflowId: string, groupId: string): void {
  let bots: string[];
  try {
    bots = [...new Set(linkWorkflow({ workflowId }, lookup)!.botIds)];
  } catch (error) {
    throw new PublicError(error instanceof Error ? error.message : "This webhook cannot run that workflow.", 409);
  }
  for (const botId of bots) inRoom(botId, groupId);
}
