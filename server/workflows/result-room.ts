import type { WorkflowRun } from "../../shared/workflows.ts";
import type { RoutineRun } from "../routines.ts";
import type { BotRecord, Store } from "../store.ts";

export interface ResultRoomDeps {
  /** The room of the webhook that started a run, if it names one. */
  webhookRoom(webhookId: string): string | undefined;
  room(groupId: string): { threadId: string; memberIds: readonly string[]; dm?: boolean } | undefined;
  workflowRun(runId: string): Pick<WorkflowRun, "stepRuns"> | null;
}

export type ResultRoom = { groupId: string; threadId: string; botId: string };

type Run = Pick<RoutineRun, "id" | "botId" | "target" | "groupId" | "threadId" | "workflowId" | "triggerSource" | "eventSource" | "webhookId">;

/** The bot whose output a step posts: the step's own bot, or the bot of the step it received its input from. */
function authorOf(run: Pick<WorkflowRun, "stepRuns"> | null, stepId: string): string | undefined {
  const steps = run?.stepRuns ?? [];
  const seen = new Set<string>();
  for (let at = steps.findLast((step) => step.stepId === stepId); at && !seen.has(at.stepId);) {
    if (at.botId) return at.botId;
    seen.add(at.stepId);
    const from = at.fromStepId;
    at = from === undefined ? undefined : steps.findLast((step) => step.stepId === from);
  }
  return undefined;
}

/** Where a workflow run posts a result when its start names a room: a room goal's own conversation, or the room of the
 * webhook that started it, said by the bot that wrote the result. Null when the start names no room, the room is gone,
 * or that bot is no longer in it. */
export function workflowResultRoom(run: Run, stepId: string, deps: ResultRoomDeps): ResultRoom | null {
  if (run.workflowId === undefined) return null;
  const fromWebhook = run.target === "bot" && run.triggerSource === "webhook" && run.eventSource === undefined && run.webhookId !== undefined;
  const groupId = run.target === "room-goal" ? run.groupId : fromWebhook ? deps.webhookRoom(run.webhookId!) : undefined;
  const room = groupId ? deps.room(groupId) : undefined;
  if (!groupId || !room || room.dm) return null;
  const threadId = run.target === "room-goal" ? run.threadId : room.threadId;
  const botId = authorOf(deps.workflowRun(run.id), stepId) ?? run.botId;
  return threadId && room.memberIds.includes(botId) ? { groupId, threadId, botId } : null;
}

export function createResultRooms(deps: Omit<ResultRoomDeps, "room"> & { store: Pick<Store, "bot" | "group" | "markGroupThreadUnread" | "patchGroup"> }) {
  const { store } = deps;
  return (run: Run, stepId: string): { bot: BotRecord; threadId: string; unread(): void } | null => {
    const room = workflowResultRoom(run, stepId, { ...deps, room: (groupId) => store.group(groupId) });
    const bot = room ? store.bot(room.botId) : undefined;
    if (!room || !bot || bot.hidden) return null;
    return { bot, threadId: room.threadId, unread: () => void (store.markGroupThreadUnread(room.groupId, room.threadId, true) ?? store.patchGroup(room.groupId, { unread: true })) };
  };
}
