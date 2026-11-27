import { linkWorkflow, type WorkflowCopyLookup } from "./routine-link.ts";

/** The fields a linked workflow sets on a webhook or app trigger. Throws a person's words when it cannot be linked. */
export function startWorkflowFields(workflowId: string, lookup: WorkflowCopyLookup | undefined): { workflowId: string; prompt: string; botId: string } {
  const copy = linkWorkflow({ workflowId }, lookup)!;
  return { workflowId: copy.workflowId, prompt: copy.prompt, botId: copy.botId };
}

/** Every bot that writes in the workflow's steps. */
export function startWorkflowBots(workflowId: string, lookup: WorkflowCopyLookup | undefined): string[] {
  return [...new Set(linkWorkflow({ workflowId }, lookup)!.botIds)];
}
