import type { ImportSourceKind } from "../shared/ai-import/bundle.ts";
import { messageRow, prepared, setActiveLeaf, transaction } from "./message-db.ts";
import type { Message, Store, TaskRecord } from "./store.ts";
import { buildTask } from "./task-record.ts";

export interface ImportedThreadMark { kind: ImportSourceKind; label: string }

export interface ImportedThreadInput { threadId: string; title: string; createdAt: number; updatedAt: number; imported: ImportedThreadMark }

export interface ImportedMessageInput { id: string; parentId: string | null; role: "user" | "bot"; text: string; at: number }

export interface ImportedThreadPart { threadId: string; messages: ImportedMessageInput[]; activeLeafId: string | null }

/** Adds each conversation as an archived thread with its source mark. A thread id the bot already has is kept as it is. */
export function createImportedThreads(store: Store, botId: string, inputs: ImportedThreadInput[]): TaskRecord[] | null {
  const host = store.importedThreads();
  const bot = host.own(botId);
  if (!bot) return null;
  const known = new Map((bot.tasks ?? []).map((task) => [task.threadId, task]));
  const made: TaskRecord[] = [];
  const result = inputs.map((input) => {
    const existing = known.get(input.threadId);
    if (existing) return existing;
    const task: TaskRecord = {
      ...buildTask(bot, input.title),
      threadId: input.threadId,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      lastThreadOrderAt: input.updatedAt,
      archivedAt: Date.now(),
      imported: { kind: input.imported.kind, label: input.imported.label },
    };
    known.set(task.threadId, task);
    made.push(task);
    return task;
  });
  if (!made.length) return result;
  host.commit(bot, () => { bot.tasks = [...made, ...(bot.tasks ?? [])]; });
  host.changed(botId);
  return result;
}

/** Writes every part in one transaction. A message id the thread already holds stays as it is; the count is the new messages. */
export function appendImportedMessages(store: Store, parts: ImportedThreadPart[]): number {
  const rows = parts.map((part) => ({
    threadId: part.threadId,
    activeLeafId: part.activeLeafId,
    messages: part.messages.map((message): Message => ({ id: message.id, parentId: message.parentId, role: message.role, kind: "text", text: message.text, at: message.at })),
  }));
  const added = transaction((database) => {
    const insert = database.prepare(
      "INSERT INTO messages (thread_id, id, at, role, kind, text, json, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(thread_id, id) DO NOTHING");
    let count = 0;
    for (const part of rows) {
      for (const message of part.messages) count += Number(insert.run(...messageRow(part.threadId, message)).changes);
      if (part.activeLeafId !== null) setActiveLeaf(part.threadId, part.activeLeafId);
    }
    return count;
  });
  const host = store.importedThreads();
  for (const part of rows) {
    const newest = part.messages.reduce((max, message) => Math.max(max, message.at), Number.NEGATIVE_INFINITY);
    host.touched(part.threadId, Number.isFinite(newest) ? newest : null);
  }
  return added;
}

export function removeImportedMessages(store: Store, threadId: string, ids: string[], activeLeafId: string | null): number {
  const removed = transaction((database) => {
    const remove = database.prepare("DELETE FROM messages WHERE thread_id = ? AND id = ?");
    let count = 0;
    for (const id of ids) count += Number(remove.run(threadId, id).changes);
    setActiveLeaf(threadId, activeLeafId);
    return count;
  });
  store.importedThreads().touched(threadId, null);
  return removed;
}

/** Null when the conversation has no message and no state. */
export function importedThreadStats(threadId: string): { messages: number; activeLeafId: string | null } | null {
  const { n } = prepared("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?").get(threadId) as { n: number };
  const state = prepared("SELECT active_leaf_id FROM thread_state WHERE thread_id = ?").get(threadId) as { active_leaf_id: string | null } | undefined;
  if (!state && n === 0) return null;
  return { messages: n, activeLeafId: state?.active_leaf_id ?? null };
}

export function importedMark(store: Store, botId: string, threadId: string): ImportedThreadMark | undefined {
  return store.taskByThread(botId, threadId)?.imported;
}
