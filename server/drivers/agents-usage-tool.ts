// The agents catalog's usage_limits tool: one read of the plan-usage data the app's own Usage page shows. The internal
// route (server/routes/engine-limits.ts) decides which accounts this conversation may see.
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";

export const USAGE_LIMITS_TOOL = "usage_limits";

export async function callUsageLimitsTool(context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } = await context.client.apiResponse("/api/internal/engine-limits");
  return ok ? { text: String(body.text ?? "") } : { text: String(body.error ?? "Usage limits could not be read. Try again shortly."), isError: true };
}

export const USAGE_LIMITS_TOOL_DEFINITION = {
  name: USAGE_LIMITS_TOOL,
  description: "Each AI account's usage limits: percent used, reset time, when checked. status: ok, unknown (no data now; see why) or unsupported.",
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
};

export const MACHINE_BUDGET_TOOL = "machine_budget";

export async function callMachineBudgetTool(context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } = await context.client.apiResponse("/api/internal/machine-budget");
  return ok ? { text: String(body.text ?? "") } : { text: String(body.error ?? "The computer's free memory could not be read. Run the job with one worker."), isError: true };
}

export const MACHINE_BUDGET_TOOL_DEFINITION = {
  name: MACHINE_BUDGET_TOOL,
  description: "Free memory (GB), CPUs, suggested parallel workers and heavy work running now. Call before a heavy job. unknown: not readable.",
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
};
