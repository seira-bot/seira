import { linkWorkflow, workflowRefusal, type WorkflowCopyLookup } from "./routine-link.ts";

export interface StartLinkFields {
  runOn: string;
  sameConversation?: boolean;
  /** A webhook that posts into a chat instead of starting a run. */
  posts?: boolean;
}

/** The fields a linked workflow sets on a webhook or app trigger. Throws a person's words when it cannot be linked. */
export function startWorkflowFields(workflowId: string, lookup: WorkflowCopyLookup | undefined, fields: StartLinkFields): { workflowId: string; prompt: string; botId: string } {
  const copy = linkWorkflow({ workflowId }, lookup)!;
  const refused = workflowRefusal({ target: "bot", runOn: fields.runOn, sameConversation: fields.sameConversation, deliver: fields.posts ? "post" : undefined, scheduleType: "event" });
  if (refused) throw new Error(refused);
  return { workflowId: copy.workflowId, prompt: copy.prompt, botId: copy.botId };
}
