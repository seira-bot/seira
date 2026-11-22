import type { WireTask } from "../../shared/wire";

const RECENT_MS = 14 * 24 * 60 * 60 * 1000;

/** The chat to point a person at when the one they are in is empty: the bot's newest open chat that has messages in
 * it and was active lately. Null when there is none. */
export function threadToContinue(tasks: readonly WireTask[] | undefined, currentThreadId: string, now = Date.now()): WireTask | null {
  let newest: WireTask | null = null;
  for (const task of tasks ?? []) {
    if (task.threadId === currentThreadId || task.routineRunId || task.archivedAt !== undefined || task.closedBy) continue;
    const active = task.updatedAt ?? task.createdAt;
    if (active <= task.createdAt || now - active > RECENT_MS) continue;
    if (!newest || active > (newest.updatedAt ?? newest.createdAt)) newest = task;
  }
  return newest;
}
