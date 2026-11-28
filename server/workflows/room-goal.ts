import type { WorkflowGraph } from "../../shared/workflows.ts";

export type RoomGoalRefusal = { status: 400 | 403; error: string };

/** The room a room goal runs in: undefined when the goal names none, null when it is gone. */
export type RoomGoalRoom = { memberIds: readonly string[]; dm?: boolean } | null | undefined;

export const ROOM_GOAL_READS_AND_DRAFTS = "A room goal can't be set to reads and drafts only. Turn that off for the automation and each step.";

/** Why a room goal cannot run these steps in its room, in a person's words; null when it can. Each bot step is a turn
 * of that bot in the room, on its own model and with the room's tools, so every bot must be a member, and no step may
 * choose a model or reads and drafts only. */
export function roomGoalProblem(graph: Pick<WorkflowGraph, "steps">, room: RoomGoalRoom, botName: (botId: string) => string | undefined, access?: string): RoomGoalRefusal | null {
  if (room === undefined) return { status: 400, error: "Choose a room for this goal." };
  if (room === null || room.dm) return { status: 400, error: "This goal's room no longer exists. Choose another room." };
  for (const step of graph.steps) {
    if (step.kind !== "bot" || room.memberIds.includes(step.botId)) continue;
    const name = botName(step.botId);
    return { status: 403, error: name ? `${name} isn't in this room. Add ${name} to the room first.` : "A bot in these steps isn't in this room. Add it to the room first." };
  }
  if (graph.steps.some((step) => step.kind === "bot" && step.modelSelection !== undefined)) {
    return { status: 400, error: "Room goals run on their bots' own models. Remove the model choice from each step." };
  }
  if (access !== undefined || graph.steps.some((step) => step.kind === "bot" && step.access !== undefined)) return { status: 400, error: ROOM_GOAL_READS_AND_DRAFTS };
  return null;
}

type Fields = { target?: unknown; groupId?: unknown; workflowId?: unknown; access?: unknown };

/** The room check of a routine save: the fields it saves, over the routine it changes. */
export function roomGoalSaveRefusal(
  body: unknown,
  existing: { target?: string; groupId?: string; workflowId?: string; access?: string } | undefined,
  deps: { workflow(id: string): Pick<WorkflowGraph, "steps"> | null | undefined; room(groupId: string): RoomGoalRoom; botName(botId: string): string | undefined },
): RoomGoalRefusal | null {
  const fields: Fields = body && typeof body === "object" ? body as Fields : {};
  const target = fields.target ?? existing?.target ?? "bot";
  const workflowId = Object.hasOwn(fields, "workflowId") ? fields.workflowId : existing?.workflowId;
  if (target !== "room-goal" || typeof workflowId !== "string" || !workflowId) return null;
  const workflow = deps.workflow(workflowId);
  if (!workflow) return null;
  const groupId = Object.hasOwn(fields, "groupId") ? fields.groupId : existing?.groupId;
  const access = Object.hasOwn(fields, "access") ? fields.access ?? undefined : existing?.access;
  return roomGoalProblem(workflow, typeof groupId === "string" && groupId.trim() ? deps.room(groupId.trim()) : undefined, deps.botName, access === undefined ? undefined : String(access));
}
