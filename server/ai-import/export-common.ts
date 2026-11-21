import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { ImportEntry, ImportFiles } from "./reader.ts";

const CONVERSATION_FILE = /(?:^|\/)conversations(?:-(\d+))?\.json$/;
const HEAD_BYTES = 64 * 1024;

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function baseName(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}

/** `conversations.json` first, then `conversations-0.json`, `conversations-000.json`, `-001`… in number order. */
export function conversationFiles(entries: readonly ImportEntry[]): ImportEntry[] {
  const found: { entry: ImportEntry; number: number }[] = [];
  for (const entry of entries) {
    const match = CONVERSATION_FILE.exec(entry.name);
    if (match) found.push({ entry, number: match[1] === undefined ? -1 : Number(match[1]) });
  }
  found.sort((a, b) => a.number - b.number || a.entry.name.localeCompare(b.entry.name));
  return found.map((item) => item.entry);
}

export function hasEntry(entries: readonly ImportEntry[], file: string): boolean {
  return entries.some((entry) => baseName(entry.name) === file);
}

export async function peekHead(files: ImportFiles, name: string): Promise<string> {
  const stream = await files.open(name);
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      chunks.push(buffer);
      length += buffer.length;
      if (length >= HEAD_BYTES) break;
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks).subarray(0, HEAD_BYTES).toString("utf8");
}

export function fingerprintOf(kind: string, seed: string): string {
  return createHash("sha256").update(`${kind}\n${seed}`).digest("hex").slice(0, 32);
}

export function entriesSeed(entries: readonly ImportEntry[]): string {
  return entries.map((entry) => `${entry.name}:${entry.size}`).join("\n");
}

export function toMillis(seconds: number | null): number | null {
  return seconds === null ? null : Math.round(seconds * 1000);
}

export function parseTime(value: unknown): number | null {
  const text = asString(value);
  if (text === null) return null;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

export class ByteProgress {
  done = 0;
  private reported = 0;
  private readonly total: number;

  constructor(total: number) {
    this.total = total;
  }

  async *count(stream: Readable): AsyncGenerator<Buffer> {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      this.done += buffer.length;
      yield buffer;
    }
  }

  /** Returns a progress value once at least `step` bytes have passed since the last one. */
  next(step = 1024 * 1024): { done: number; total: number } | null {
    if (this.done - this.reported < step) return null;
    this.reported = this.done;
    return { done: this.done, total: this.total };
  }

  last(): { done: number; total: number } {
    return { done: this.total, total: this.total };
  }
}

export function leftoverRef(index: number): string {
  return `conversation-${index + 1}`;
}
