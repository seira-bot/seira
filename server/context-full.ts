import { contextOverflow } from "./drivers/engine-errors.ts";

/** Threads whose last turn stopped because the engine's conversation no longer fit its model. The next turn folds
 * them whatever their last measured size was. Held in memory: a restart starts the next turn from a fresh session. */
const full = new Set<string>();

export const contextFullStop = (stopReason: string | null | undefined, failure?: string): boolean =>
  stopReason === "context_full" || (failure !== undefined && contextOverflow(failure));

export const contextFull = {
  mark: (threadId: string): void => void full.add(threadId),
  has: (threadId: string): boolean => full.has(threadId),
  clear: (threadId: string): void => void full.delete(threadId),
  /** The thread has nothing to fold: the next turn starts a new session from the replay of its messages instead. */
  release(threadId: string, instanceId: string, cursors: Record<string, unknown>, patch: (cursors: Record<string, unknown>) => void): void {
    full.delete(threadId);
    patch(Object.fromEntries(Object.entries(cursors).filter(([id]) => id !== instanceId)));
  },
};

/** What the Chief reads when a run stopped on a full conversation. */
export const CONTEXT_FULL_NOTE =
  "The conversation in that thread grew too long for the AI. Seira already moved the thread to a new session that starts from a summary of the earlier messages, so retry_thread continues the work there. Do not start another thread for it.";
