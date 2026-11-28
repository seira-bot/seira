// The agents catalog's usage_limits tool: one read of the plan-usage data the app's own Usage page shows. The internal
// route (server/routes/engine-limits.ts) decides which accounts this conversation may see.
import { TASK_KINDS } from "../machine-task-kinds.ts";
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

export async function callMachineBudgetTool(context: ToolCallContext, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
  const query = new URLSearchParams();
  if (typeof args.task === "string" && args.task) query.set("task", args.task);
  if (typeof args.size_gb === "number") query.set("size_gb", String(args.size_gb));
  if (typeof args.count === "number") query.set("count", String(args.count));
  const text = query.toString();
  const { ok, body } = await context.client.apiResponse(`/api/internal/machine-budget${text ? `?${text}` : ""}`);
  return ok ? { text: String(body.text ?? "") } : { text: String(body.error ?? "The computer's free memory could not be read. Run the job with one worker."), isError: true };
}

export const MACHINE_BUDGET_TOOL_DEFINITION = {
  name: MACHINE_BUDGET_TOOL,
  description: "This computer's memory, processors, disk, suggested parallel workers, heavy work running now, and how many bots can work at once. With task: whether this computer fits that job, and a lighter way. Call before a heavy job or a big team. unknown: not readable.",
  inputSchema: {
    type: "object", additionalProperties: false,
    properties: {
      task: { type: "string", enum: [...TASK_KINDS], description: "The kind of job to check." },
      size_gb: { type: "number", description: "local_model: the model's size; large_files: the files' size." },
      count: { type: "integer", description: "browsers: pages at once; more_bots: new bots." },
    },
  },
};

export const capacityNote = (r: Record<string, unknown>): string => typeof r.capacityNote === "string" ? `\n\n${r.capacityNote}` : "";
/** A setup that was held because this computer is small for the team: the text tells the bot to explain and ask. */
export const capacityHeld = (r: Record<string, unknown>): { text: string } | undefined => r.state === "held" && typeof r.capacityHold === "string" ? { text: r.capacityHold } : undefined;
