import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import type { ImportEvent, ImportSourceKind } from "../../shared/ai-import/bundle.ts";
import type { LocalSource, ReaderContext, SourceReader } from "./reader.ts";
import { sourceId } from "./local-fs.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function copyFixture(name: "hermes" | "openclaw" | "claude-code", to: string): string {
  cpSync(join(fixtures, name), to, { recursive: true });
  return to;
}

export function localSource(kind: ImportSourceKind, path: string, profile?: string, name: string = kind): LocalSource {
  return { id: sourceId(kind, path, profile), kind, path, name, ...(profile ? { profile } : {}) };
}

export function context(stagingDir: string, transcripts = false): ReaderContext {
  return { signal: new AbortController().signal, stagingDir, transcripts };
}

export async function collect(reader: SourceReader, source: LocalSource, ctx: ReaderContext): Promise<ImportEvent[]> {
  const events: ImportEvent[] = [];
  for await (const event of reader.read({ from: "local", source }, ctx)) events.push(event);
  return events;
}

export function writeHermesDatabase(path: string): void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, title TEXT, started_at REAL, ended_at REAL)");
  db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, timestamp REAL)");
  db.exec("INSERT INTO sessions VALUES ('s1', 'cli', 'Plan the trip', 1767340800.5, 1767341000), ('s2', 'telegram', NULL, 1767430800, NULL)");
  const add = db.prepare("INSERT INTO messages (session_id, role, content, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?)");
  add.run("s1", "user", "Where should we go?", null, 1767340801);
  add.run("s1", "assistant", "How about Porto?", '[{"function":{"name":"web_search"}}]', 1767340802);
  add.run("s1", "tool", "search results", null, 1767340803);
  add.run("s1", "user", "Sounds good", null, 1767340804);
  add.run("s2", "user", "Remind me about the bank", null, 1767430801);
  db.close();
}

export function writeOpenclawDatabase(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, created_at INTEGER, updated_at INTEGER)");
  db.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, created_at INTEGER)");
  db.exec("INSERT INTO sessions VALUES ('db-1', 'Tea order', 1767340800000, 1767341000000)");
  const add = db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?)");
  add.run("dm1", "db-1", "user", "Order green tea", 1767340801000);
  add.run("dm2", "db-1", "assistant", JSON.stringify([{ type: "text", text: "Done, one box." }, { type: "toolCall", name: "shop" }]), 1767340802000);
  db.close();
}

export const TRAP_TEXT = "TRAP-SECRET-VALUE";

/** Credential files that no reader may open, placed in the home, workspaces and skill folders. */
export function plantTraps(root: string, folders: string[]): void {
  for (const folder of ["", ...folders]) {
    const base = join(root, folder);
    mkdirSync(join(base, "credentials"), { recursive: true });
    for (const name of [".env", "auth.json", ".credentials.json", "secrets.json", "auth-profiles.json", join("credentials", "x")]) writeFileSync(join(base, name), TRAP_TEXT);
  }
}
