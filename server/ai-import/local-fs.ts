import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";

import { AI_IMPORT_LIMITS } from "../../shared/ai-import/limits.ts";

const SECRET_NAMES = new Set([".env", "auth.json", ".credentials.json", "secrets.json", "auth-profiles.json"]);

/** Security invariant: no local reader opens a login, key or token file, whatever the caller asks for. */
export function isSecretPath(path: string): boolean {
  const parts = path.split(/[\\/]/);
  const name = (parts.at(-1) ?? "").toLowerCase();
  return SECRET_NAMES.has(name) || name.startsWith(".env.") || parts.some((part) => part.toLowerCase() === "credentials");
}

function guard(path: string): void {
  if (isSecretPath(path)) throw new Error("Refusing to open a credential file");
}

export function sourceId(kind: string, path: string, profile?: string): string {
  return createHash("sha256").update(`${kind}\0${path}\0${profile ?? ""}`).digest("hex").slice(0, 16);
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function isFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

export async function listNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

export async function listDirectories(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for (const item of await readdir(dir, { withFileTypes: true })) if (item.isDirectory()) out.push(item.name);
  } catch {
    return [];
  }
  return out.sort();
}

/** A regular file only: a link is never followed out of the source folder. Null when missing, unreadable or too large. */
export async function readText(path: string, maxBytes: number = AI_IMPORT_LIMITS.otherMemberBytes): Promise<string | null> {
  guard(path);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > maxBytes) return null;
    return (await readFile(path, "utf8")).replace(/^﻿/, "");
  } catch {
    return null;
  }
}

/** Copies regular files and folders, skipping links and credential files, until `budget` bytes are used. */
export async function copyTree(from: string, to: string, budget: { left: number } = { left: AI_IMPORT_LIMITS.otherMemberBytes }): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const item of await readdir(from, { withFileTypes: true })) {
    const source = join(from, item.name);
    if (isSecretPath(source)) continue;
    const target = join(to, item.name);
    if (item.isDirectory()) await copyTree(source, target, budget);
    else if (item.isFile()) {
      const size = (await lstat(source)).size;
      if (size > budget.left) continue;
      budget.left -= size;
      await copyFile(source, target);
    }
  }
}

export async function copyFileTo(from: string, to: string): Promise<boolean> {
  guard(from);
  try {
    if (!(await lstat(from)).isFile()) return false;
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
    return true;
  } catch {
    return false;
  }
}

/** Calls `onLine` for each line; a line over the message limit is dropped, not truncated. */
export async function eachLine(path: string, signal: AbortSignal, onLine: (line: string) => void): Promise<void> {
  guard(path);
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (signal.aborted) return;
      if (line.length <= AI_IMPORT_LIMITS.messageTextBytes) onLine(line);
    }
  } finally {
    lines.close();
  }
}

export function splitEntries(text: string): string[] {
  return text.split("§").map((entry) => entry.trim()).filter(Boolean);
}

export function fileLabel(path: string): string {
  return basename(path).replace(/\.[^.]+$/, "");
}

/** Epoch seconds or milliseconds, a numeric string or an ISO string, as milliseconds. */
export function toMillis(value: unknown): number | null {
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) value = Number(value);
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text parts of a message body that is a string or a list of typed blocks. */
export function blocksText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    else if (isRecord(block) && typeof block.text === "string" && (block.type === undefined || block.type === "text" || block.type === "output_text" || block.type === "input_text")) parts.push(block.text);
  }
  return parts.join("\n");
}

export function toolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => (isRecord(block) && (block.type === "toolCall" || block.type === "tool_use") && typeof block.name === "string" ? [block.name] : []));
}
