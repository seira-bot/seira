import type { WorkflowRun } from "../../shared/workflows.ts";
import type { RoomTalksVerdict } from "../host/room-access.ts";
import type { RoutineRun } from "../routines.ts";
import type { BotRecord, GroupRecord, Store } from "../store.ts";

export interface ResultRoomDeps {
  store: Pick<Store, "bot" | "group" | "markGroupThreadUnread" | "patchGroup">;
  /** The room of the webhook that started a run, if it names one. */
  webhookRoom(webhookId: string): string | undefined;
  workflowRun(runId: string): Pick<WorkflowRun, "stepRuns"> | null;
  /** The same verdict a webhook's own room post and a bot's post_to_room call get. */
  roomTalks(bot: BotRecord, group: GroupRecord): RoomTalksVerdict;
}

/** Security: `webhookPost` marks a result a webhook started, so the room's other bots read it as outside words. */
export type ResultRoom = { bot: BotRecord; threadId: string; webhookPost: boolean; unread(): void };

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
 * or that bot may not speak there. */
export function createResultRooms(deps: ResultRoomDeps) {
  const { store } = deps;
  return (run: Run, stepId: string): ResultRoom | null => {
    if (run.workflowId === undefined) return null;
    const fromWebhook = run.target === "bot" && run.triggerSource === "webhook" && run.eventSource === undefined && run.webhookId !== undefined;
    const groupId = run.target === "room-goal" ? run.groupId : fromWebhook ? deps.webhookRoom(run.webhookId!) : undefined;
    const group = groupId ? store.group(groupId) : undefined;
    const threadId = run.target === "room-goal" ? run.threadId : group?.threadId;
    const bot = group ? store.bot(authorOf(deps.workflowRun(run.id), stepId) ?? run.botId) : undefined;
    if (!group || !threadId || !bot || bot.hidden || !deps.roomTalks(bot, group).ok) return null;
    return { bot, threadId, webhookPost: fromWebhook, unread: () => void (store.markGroupThreadUnread(group.id, threadId, true) ?? store.patchGroup(group.id, { unread: true })) };
  };
}
