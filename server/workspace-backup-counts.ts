import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** Thread and message counts of a backed-up message database, after an integrity check. */
export function databaseCounts(path: string): { threads: number; messages: number } {
  if (!existsSync(path)) return { threads: 0, messages: 0 };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const check = db.prepare("PRAGMA quick_check").all();
    if (check.length !== 1 || Object.values(check[0])[0] !== "ok") throw new Error("The message database failed its integrity check.");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('messages', 'thread_state')").all();
    if (tables.length !== 2) throw new Error("The backup does not contain a supported message database.");
    const counts = db.prepare("SELECT COUNT(*) AS messages, COUNT(DISTINCT thread_id) AS threads FROM messages").get()!;
    return { threads: Number(counts.threads), messages: Number(counts.messages) };
  } finally { db.close(); }
}
