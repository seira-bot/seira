// Automations that keep one conversation (sameConversation: webhooks, app events and schedules): each run continues the
// conversation its trigger's run before worked in. Runs of such a trigger take turns in it (sameRoutineWorking in routines.ts).
import { approvalModeFor } from "../shared/approval-mode.ts";
import type { RoutineAccess } from "../shared/routines.ts";
import type { WorkflowStep } from "../shared/workflows.ts";
import { sameModelSelection } from "../shared/thread-model.ts";
import type { ModelSelection } from "./contracts.ts";
import type { RoutineRun } from "./routines.ts";
import type { Store } from "./store.ts";
import { buildTask } from "./task-record.ts";

/** The conversation the same trigger's latest earlier run for this bot worked in; null for its first run. `runs` newest first (listRuns). */
export function previousEventThread(runs: readonly RoutineRun[], run: Pick<RoutineRun, "id" | "routineId" | "botId">): string | null {
  if (!run.routineId) return null;
  return runs.find((other) => other.id !== run.id && other.routineId === run.routineId && other.botId === run.botId && other.threadId)?.threadId ?? null;
}

/** The conversation a run that keeps one conversation joins. Gone (deleted) or never there: null, so this run starts a
 *  new conversation and the next run continues that one. */
export function continuedConversation(runs: readonly RoutineRun[], run: RoutineRun, exists: (threadId: string) => boolean): string | null {
  const previous = run.target === "bot" ? previousEventThread(runs, run) : null;
  return previous && exists(previous) ? previous : null;
}

/** What a run would open a new conversation with now: the model its turn runs on and the access it has there. */
export interface ChatNeeds {
  modelSelection: ModelSelection | undefined;
  access: RoutineAccess | undefined;
}

const allowList = (tools: readonly string[] | undefined): string => [...new Set(tools ?? [])].sort().join("\n");

/** Security: a run continues a conversation only while it is what a new one would be now: the same bot, model, approval
 *  and access. A change since the conversation's last run, to the automation, the bot or the conversation, opens a new
 *  one, so wider settings never carry over. `owner` is the run whose access applies in that conversation. */
export function continuesChat(store: Pick<Store, "bot" | "projectBotForTask">, botId: string, threadId: string,
  owner: Pick<RoutineRun, "access"> | null, needs: ChatNeeds): boolean {
  const bot = store.bot(botId);
  const chat = store.projectBotForTask(botId, threadId);
  if (!bot || bot.hidden || !chat || !owner || owner.access !== needs.access) return false;
  const fresh = buildTask(bot, undefined, undefined, undefined, undefined, needs.modelSelection);
  return sameModelSelection(chat.modelSelection, fresh.modelSelection ?? bot.modelSelection)
    && approvalModeFor(chat) === approvalModeFor(fresh) && allowList(chat.alwaysAllow) === allowList(fresh.alwaysAllow);
}

/** The access a run has in its own conversation: its first step's own choice when that step works there. */
export function ownChatAccess(run: Pick<RoutineRun, "access" | "botId">, start: WorkflowStep | undefined): RoutineAccess | undefined {
  return start?.kind === "bot" && start.botId === run.botId && start.modelSelection === undefined ? start.access ?? run.access : run.access;
}
