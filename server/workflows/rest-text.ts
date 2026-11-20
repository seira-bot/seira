export const WORKFLOW_TIME_WAIT = "Waiting for the planned time";

const BOT_WAIT_START = "Waiting for ";
const BOT_WAIT_END = " to finish other work";

export const workflowBotWait = (name: string): string => `${BOT_WAIT_START}${name}${BOT_WAIT_END}`;

/** True for the attention text of a workflow run that waits on the clock or on a busy bot: nobody needs to act. */
export function isWorkflowRest(attention: string | undefined): boolean {
  return attention === WORKFLOW_TIME_WAIT || (attention !== undefined && attention.startsWith(BOT_WAIT_START) && attention.endsWith(BOT_WAIT_END));
}
