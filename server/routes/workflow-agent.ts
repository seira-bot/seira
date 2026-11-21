import type { Workflow } from "../../shared/workflows.ts";
import type { InternalTriggerContext } from "../app-trigger-host.ts";
import type { WorkflowHost } from "../host/workflow-host.ts";
import type { RosterMember } from "../peer-roster.ts";
import type { Routine, RoutineManager } from "../routines.ts";
import { CANNOT_SET_UP_FOR, triggerTarget } from "../trigger-tools.ts";
import { canManage } from "../peer-roster.ts";
import { agentWorkflows, sequentialWorkflow, TEAM_WORKFLOW_REFUSAL } from "../workflows/agent-tools.ts";
import { problemBody, runnableProblem, validateWorkflowInput } from "../workflows/validate.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

const GUEST_REFUSAL = "Only the Cloud's owner can make workflows. Tell the person to ask from their own conversation.";
const READ_GUEST_REFUSAL = "Only the Cloud's owner can read workflows. Tell the person to ask from their own conversation.";
const ROUTE = "/api/internal/workflows";

export interface WorkflowAgentDeps {
  workflows(): Pick<WorkflowHost, "list" | "create"> | null;
  routines(): Pick<RoutineManager, "listRoutines"> | null;
  bot(id: string): InternalTriggerContext["from"] | null | undefined;
  /** The name of a bot this turn's bot may reach, itself included; undefined for any other. */
  reachableName(from: RosterMember, threadId: string, botId: string): string | undefined;
  /** Whether the person behind this turn may see the workflow (the Workflows page rule). */
  shown(workflow: { steps?: unknown }, threadId: string): boolean;
  /** True on a Team Cloud, where people draw and link workflows themselves. */
  team(): boolean;
  /** Who a workflow made by this bot is recorded under. */
  creator(): string | undefined;
}

export function createWorkflowAgentRoutes(deps: WorkflowAgentDeps): (context: InternalTriggerContext) => RouteHandler {
  return (context) => async ({ req, res, url, path, method, json, readBody }: RouteContext) => {
    if (path !== ROUTE || (method !== "GET" && method !== "POST")) return PASS;
    const host = deps.workflows();
    if (!host) return json(res, 503, { error: "Workflows are unavailable." });
    if (method === "GET") {
      if (!context.ownsThread(context.from.id, context.threadId)) return json(res, 403, { error: "source conversation does not belong to sender" });
      if (context.guestDriven) return json(res, 403, { error: READ_GUEST_REFUSAL });
      const target = triggerTarget(context.from, url.searchParams.get("forBotId") ?? undefined, (id) => deps.bot(id));
      if ("error" in target) return json(res, target.status, { error: target.error });
      const ownerId = target.forBot?.botId ?? context.from.id;
      const routines = (deps.routines()?.listRoutines() ?? []).filter((routine: Routine) => context.routineShown?.(routine) ?? true);
      const workflows = agentWorkflows(host.list().filter((workflow) => deps.shown(workflow, context.threadId)), {
        botId: ownerId,
        botName: (id) => deps.reachableName(context.from, context.threadId, id) ?? (id === ownerId ? deps.bot(id)?.name : undefined),
        routines,
      });
      return json(res, 200, { workflows });
    }
    if (!context.ownsThread(context.from.id, context.threadId)) return json(res, 403, { error: "source conversation does not belong to sender" });
    if (deps.team()) return json(res, 403, { error: TEAM_WORKFLOW_REFUSAL });
    if (context.guestDriven) return json(res, 403, { error: GUEST_REFUSAL });
    const body = await readBody(req) as Record<string, unknown> | null;
    const built = sequentialWorkflow({ name: body?.name, steps: body?.steps }, context.from.id);
    if (!built.ok) return json(res, 400, { error: built.error });
    for (const step of built.input.steps) {
      if (step.kind !== "bot" || step.botId === context.from.id) continue;
      const target = deps.reachableName(context.from, context.threadId, step.botId) === undefined ? undefined : deps.bot(step.botId);
      if (!target) return json(res, 404, { error: "no bot with that bot_id — call list_bots and copy the exact id from the result" });
      if (!canManage(context.from, target)) return json(res, 403, { error: CANNOT_SET_UP_FOR });
    }
    const botName = (id: string) => deps.reachableName(context.from, context.threadId, id);
    const checked = validateWorkflowInput(built.input, { botName });
    if (!checked.ok) return json(res, 400, problemBody(checked.problems));
    const problem = runnableProblem(checked.value, { botName });
    if (problem) return json(res, 400, problemBody([problem]));
    if (!context.canCommit()) return json(res, 401, { error: "The requesting turn ended before this workflow could be saved" });
    const workflow: Workflow = host.create(checked.value, deps.creator());
    return json(res, 201, { workflow: { id: workflow.id, name: workflow.name, steps: workflow.steps.length } });
  };
}
