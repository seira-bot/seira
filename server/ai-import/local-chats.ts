import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import type { ImportConversation, ImportMessage, ImportNote } from "../../shared/ai-import/bundle.ts";
import { blocksText, copyFileTo, eachLine, isRecord, toMillis, toolNames } from "./local-fs.ts";

/** Copies the database with its journal files into `stagingDir` and opens the copy read-only. Null when it cannot be opened. */
export async function openDatabaseCopy(source: string, stagingDir: string, label: string): Promise<DatabaseSync | null> {
  const target = join(stagingDir, `${label}.db`);
  if (!(await copyFileTo(source, target))) return null;
  await copyFileTo(`${source}-wal`, `${target}-wal`);
  await copyFileTo(`${source}-shm`, `${target}-shm`);
  for (const readOnly of [true, false]) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(target, { readOnly });
      db.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
      return db;
    } catch {
      try {
        db?.close();
      } catch {
        // the handle is already unusable
      }
    }
  }
  return null;
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

function columnsOf(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function pick(columns: string[], wanted: string[]): string | undefined {
  const lower = new Map(columns.map((name) => [name.toLowerCase(), name]));
  for (const name of wanted) {
    const found = lower.get(name.toLowerCase());
    if (found) return found;
  }
  return undefined;
}

interface SessionRow {
  title: string;
  createdAt: number | null;
  updatedAt: number | null;
}

/** Finds the sessions and messages tables by shape, because the layout differs between tools and versions. */
export function* databaseConversations(db: DatabaseSync, filter: (sessionId: string) => boolean = () => true): Generator<ImportConversation> {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
  let messageTable: { name: string; session: string; role: string; text: string; time?: string; id?: string; tools?: string } | undefined;
  let sessionTable: { name: string; id: string; title?: string; created?: string; updated?: string } | undefined;
  for (const name of tables) {
    const columns = columnsOf(db, name);
    if (!messageTable && /messages?$/i.test(name)) {
      const session = pick(columns, ["session_id", "sessionId", "conversation_id", "thread_id"]);
      const role = pick(columns, ["role", "sender"]);
      const text = pick(columns, ["content", "text", "body"]);
      if (session && role && text) messageTable = { name, session, role, text, time: pick(columns, ["timestamp", "created_at", "createdAt", "time", "ts"]), id: pick(columns, ["id", "message_id", "messageId"]), tools: pick(columns, ["tool_calls", "toolCalls"]) };
    } else if (!sessionTable && /sessions?$/i.test(name)) {
      const id = pick(columns, ["id", "session_id", "sessionId"]);
      if (id) sessionTable = { name, id, title: pick(columns, ["title", "name", "summary"]), created: pick(columns, ["started_at", "created_at", "createdAt"]), updated: pick(columns, ["ended_at", "updated_at", "updatedAt"]) };
    }
  }
  if (!messageTable) return;

  const sessions = new Map<string, SessionRow>();
  if (sessionTable) {
    const select = [sessionTable.id, sessionTable.title, sessionTable.created, sessionTable.updated].filter((column): column is string => Boolean(column)).map(quote).join(", ");
    for (const row of db.prepare(`SELECT ${select} FROM ${quote(sessionTable.name)}`).all() as Array<Record<string, unknown>>) {
      sessions.set(String(row[sessionTable.id]), {
        title: sessionTable.title && typeof row[sessionTable.title] === "string" ? (row[sessionTable.title] as string) : "",
        createdAt: sessionTable.created ? toMillis(row[sessionTable.created]) : null,
        updatedAt: sessionTable.updated ? toMillis(row[sessionTable.updated]) : null,
      });
    }
  }

  const order = [quote(messageTable.session), messageTable.time ? quote(messageTable.time) : null, "rowid"].filter(Boolean).join(", ");
  const columns = [messageTable.session, messageTable.role, messageTable.text, messageTable.time, messageTable.id, messageTable.tools].filter((column): column is string => Boolean(column));
  const rows = db.prepare(`SELECT ${columns.map(quote).join(", ")} FROM ${quote(messageTable.name)} ORDER BY ${order}`).iterate() as Iterable<Record<string, unknown>>;

  let current: string | null = null;
  let messages: ImportMessage[] = [];
  const finish = (): ImportConversation | null => {
    if (current === null || messages.length === 0) return null;
    const meta = sessions.get(current);
    const firstUser = messages.find((message) => message.role === "user")?.text.split("\n")[0]?.slice(0, 80) ?? "";
    return {
      ref: current,
      title: meta?.title || firstUser || current,
      createdAt: meta?.createdAt ?? messages[0]?.at ?? null,
      updatedAt: meta?.updatedAt ?? messages.at(-1)?.at ?? null,
      activeLeafRef: messages.at(-1)?.ref ?? null,
      messages,
    };
  };

  for (const row of rows) {
    const session = String(row[messageTable.session]);
    if (session !== current) {
      const done = finish();
      if (done) yield done;
      current = filter(session) ? session : null;
      messages = [];
    }
    if (current === null) continue;
    const role = String(row[messageTable.role]).toLowerCase();
    if (role !== "user" && role !== "assistant") continue;
    const body = parseMaybeJson(row[messageTable.text]);
    const text = blocksText(body);
    const columnNotes = messageTable.tools ? toolCallNotes(row[messageTable.tools]) : [];
    const notes: ImportNote[] = columnNotes.length > 0 ? columnNotes : toolNames(body).map((name): ImportNote => ({ kind: "tool-call", name }));
    if (!text && notes.length === 0) continue;
    const ref = messageTable.id && row[messageTable.id] != null ? String(row[messageTable.id]) : `${current}#${messages.length}`;
    messages.push({ ref, parentRef: messages.at(-1)?.ref ?? null, role, text, at: messageTable.time ? toMillis(row[messageTable.time]) : null, ...(notes.length > 0 ? { notes } : {}) });
  }
  const last = finish();
  if (last) yield last;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trimStart();
  if (!trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function toolCallNotes(value: unknown): ImportNote[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((call): ImportNote => {
      const fn = isRecord(call) && isRecord(call.function) ? call.function : isRecord(call) ? call : {};
      return { kind: "tool-call", name: typeof fn.name === "string" ? fn.name : "tool" };
    });
  } catch {
    return [];
  }
}

export interface JsonlEntry {
  id: string;
  parentId: string | null;
  /** Null for a line that is part of the tree but is not a chat message. */
  message: { role: "user" | "assistant"; text: string; at: number | null; notes: ImportNote[] } | null;
}

/** Reads a transcript whose lines form a tree by id and parent id. A line that does not parse is skipped. */
export async function jsonlConversation(path: string, ref: string, signal: AbortSignal, decode: (line: Record<string, unknown>) => JsonlEntry | null): Promise<ImportConversation | null> {
  const entries = new Map<string, JsonlEntry>();
  const order: string[] = [];
  await eachLine(path, signal, (line) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const entry = decode(parsed);
    if (!entry || entries.has(entry.id)) return;
    entries.set(entry.id, entry);
    order.push(entry.id);
  });

  const nearestMessage = (parentId: string | null): string | null => {
    const seen = new Set<string>();
    let at = parentId;
    while (at !== null && !seen.has(at)) {
      seen.add(at);
      const found = entries.get(at);
      if (!found) return null;
      if (found.message) return at;
      at = found.parentId;
    }
    return null;
  };

  const messages: ImportMessage[] = [];
  for (const id of order) {
    const entry = entries.get(id);
    if (!entry?.message) continue;
    const { role, text, at, notes } = entry.message;
    messages.push({ ref: id, parentRef: nearestMessage(entry.parentId), role, text, at, ...(notes.length > 0 ? { notes } : {}) });
  }
  if (messages.length === 0) return null;
  const first = messages.find((message) => message.role === "user")?.text.split("\n")[0]?.slice(0, 80);
  return { ref, title: first || ref, createdAt: messages[0]?.at ?? null, updatedAt: messages.at(-1)?.at ?? null, activeLeafRef: messages.at(-1)?.ref ?? null, messages };
}

export function decodeMessageBody(body: unknown): { text: string; notes: ImportNote[] } {
  return { text: blocksText(body), notes: toolNames(body).map((name): ImportNote => ({ kind: "tool-call", name })) };
}
