import { botShowsUnread } from "@/lib/bot-unread";
import type { Bot, BotAnnouncement } from "./store";

/** A bot frame that carries only its changed threads (`tasksPartial`), made whole against the bot as it is known here:
 * each carried thread replaces the known one, and every other thread is kept. */
export function wholeBotFrame(known: Pick<Bot, "tasks"> | undefined, bot: BotAnnouncement): BotAnnouncement {
  const changed = new Map((bot.tasks ?? []).map((task) => [task.threadId, task]));
  if (!known?.tasks) return bot;
  const tasks = known.tasks.map((task) => {
    const next = changed.get(task.threadId);
    changed.delete(task.threadId);
    return next ?? task;
  });
  return { ...bot, tasks: [...tasks, ...changed.values()] };
}

const CLEARED_WHEN_ABSENT = [
  "browserProfile", "computer", "toolScope", "section", "managedSections", "vpsAlias", "phoneApps", "onlyPeopleAdded",
  "liveVoice", "callSpeed", "callLanguage", "startsTodos", "connectorTools", "connectorScopes", "mcpServers",
] as const satisfies readonly (keyof Bot)[];

/** A complete bot frame leaves out a setting that was cleared, so these come from the frame even when absent. */
export function clearedWhenAbsent(frame: BotAnnouncement): Pick<Bot, (typeof CLEARED_WHEN_ABSENT)[number]> {
  return Object.fromEntries(CLEARED_WHEN_ABSENT.map((key) => [key, frame[key]])) as Pick<Bot, (typeof CLEARED_WHEN_ABSENT)[number]>;
}

/** After the visible thread of a partial frame was marked read, the bot still shows unread if a thread the frame did
 * not carry is unread. */
export function unreadBeyondFrame(known: Pick<Bot, "tasks"> | undefined, bot: BotAnnouncement): boolean {
  const carried = new Set((bot.tasks ?? []).map((task) => task.threadId));
  return botShowsUnread({ unread: false, tasks: (known?.tasks ?? []).filter((task) => !carried.has(task.threadId)) }) || botShowsUnread({ unread: false, tasks: bot.tasks ?? [] });
}
