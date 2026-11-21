import { WORKFLOW_LIMITS } from "../../shared/workflows.ts";
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export const WORKFLOW_TOOL_NAMES: ReadonlySet<string> = new Set(["workflow"]);
export const WORKFLOWS_ROUTE = "/api/internal/workflows";

export const WORKFLOW_TOOL_DEFINITION = {
  name: "workflow",
  description:
    "Make a workflow: saved steps in order, shown under Automations → Workflows. It runs only when an automation uses it: then call trigger when=schedule with workflow_id. Call trigger_info action=workflows first and reuse one that fits. A check passes only on yes; on no the workflow ends. The first step must be a bot step.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["create"] },
      name: { type: "string", minLength: 1, maxLength: WORKFLOW_LIMITS.name, description: "Shown on the workflow's card." },
      steps: {
        type: "array",
        minItems: 1,
        maxItems: WORKFLOW_LIMITS.steps,
        description: "In run order. bot: a bot does the instruction, with the output of the step before. check: a yes-or-no question about that output. wait: minutes. post: posts the results to the person.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["bot", "check", "wait", "post"] },
            instruction: { type: "string", maxLength: WORKFLOW_LIMITS.instruction, description: "bot: what the bot does." },
            bot_id: { type: "string", description: "bot: another bot's id from list_bots; omit for yourself." },
            question: { type: "string", maxLength: WORKFLOW_LIMITS.question, description: "check: a question that yes or no settles." },
            minutes: { type: "integer", minimum: 1, maximum: WORKFLOW_LIMITS.waitMinutes, description: "wait: how long." },
          },
          required: ["kind"],
        },
      },
    },
    required: ["action", "name", "steps"],
  },
};

export async function callWorkflowTool(args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  if (args.action !== undefined && args.action !== "create") return { text: "workflow action is create.", isError: true };
  const { ok, status, body } = await context.client.apiResponse(WORKFLOWS_ROUTE, {
    method: "POST",
    body: JSON.stringify({ fromBotId: context.botId, fromThreadId: context.threadId, name: args.name, steps: args.steps }),
  });
  if (!ok) {
    const error = typeof body.error === "string" ? body.error : `HTTP ${status}`;
    return { text: `The workflow was not saved: ${error}\n\nDo not claim it was saved. Fix what the error says, or tell the person plainly what is missing.`, isError: true };
  }
  const workflow = body.workflow as { id?: unknown; name?: unknown; steps?: unknown } | undefined;
  return {
    text: `Saved the workflow “${String(workflow?.name ?? args.name)}” (workflow id ${String(workflow?.id)}, ${String(workflow?.steps)} steps). The person finds it under Automations → Workflows. It runs only when an automation uses it: to run it on a schedule, call trigger with when=schedule and workflow_id.`,
  };
}
