import { readSync } from "node:fs";
import { currentFormat, currentStateKeys, LEGACY_BACKUP_MAGIC } from "../electron/legacy-names.mjs";

const LEGACY_MAGIC = Buffer.from(LEGACY_BACKUP_MAGIC);

/** The magic that opens the file: the current one or the one an earlier version wrote. Throws for any other file. */
export function readBackupMagic(fd: number, current: Buffer): Buffer {
  const opening = Buffer.alloc(current.length);
  readSync(fd, opening, 0, opening.length, 0);
  if (opening.equals(current)) return current;
  if (opening.subarray(0, LEGACY_MAGIC.length).equals(LEGACY_MAGIC)) return LEGACY_MAGIC;
  throw new Error("This is not a supported encrypted workspace backup.");
}

/** Changes the format id and the client state keys an earlier version wrote to the current ones, in place. */
export function withCurrentSummary(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const manifest = value as { summary?: unknown; clientState?: unknown };
  if (typeof manifest.summary !== "object" || manifest.summary === null || Array.isArray(manifest.summary)) return;
  const summary = manifest.summary as { format?: unknown };
  summary.format = currentFormat(summary.format);
  const state = manifest.clientState;
  if (typeof state === "object" && state !== null && !Array.isArray(state)) manifest.clientState = currentStateKeys(state as Record<string, unknown>);
}
