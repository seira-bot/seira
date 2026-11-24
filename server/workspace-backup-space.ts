import { statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import { partSizes, type BackupPart } from "./workspace-backup-parts.ts";

export type FreeSpace = (path: string) => { bavail: number | bigint; bsize: number | bigint };

const MARGIN_BYTES = 64 * 1024 ** 2;

/** Bytes of regular files under a folder; links, unreadable entries, the backup folder and dependency folders are left out.
 * Parts named in `leaveOut` are not counted. */
export function dataBytes(root: string, leaveOut: readonly BackupPart[] = []): number {
  return Object.values(partSizes(root, leaveOut)).reduce((total, bytes) => total + bytes, 0);
}

/** The encrypted archive holds the data once, and the short copies of the databases (made with the native backup call) once more. */
export function backupSpaceNeeded(bytes: number, databaseBytes = 0): number {
  return bytes + databaseBytes + MARGIN_BYTES;
}

/** Bytes of the named database files under a folder; a missing one counts as nothing. */
export function databaseBytes(root: string, names: readonly string[]): number {
  let total = 0;
  for (const name of names) { try { total += statSync(join(root, name)).size; } catch { /* not there */ } }
  return total;
}

export function sizeText(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** Throws before any copy when the disk holding `directory` is too full; a failed disk query lets the backup go on. */
export function assertBackupSpace(directory: string, dataRoot: string, statfs: FreeSpace = statfsSync, leaveOut: readonly BackupPart[] = [], databases: readonly string[] = []): void {
  let free: number;
  try {
    const stats = statfs(directory);
    free = Number(stats.bavail) * Number(stats.bsize);
  } catch { return; }
  if (!Number.isFinite(free)) return;
  const needed = backupSpaceNeeded(dataBytes(dataRoot, leaveOut), databaseBytes(dataRoot, databases));
  if (free >= needed) return;
  throw new Error(`This backup needs about ${sizeText(needed)} of free disk space, and ${sizeText(free)} is free. Free some space and try again.`);
}

const MAX_LISTED = 20;

export function backupProblemsError(problems: string[]): Error {
  const shown = problems.slice(0, MAX_LISTED);
  const rest = problems.length - shown.length;
  const head = problems.length === 1 ? "1 item cannot be backed up. Fix it and try again:" : `${problems.length} items cannot be backed up. Fix them and try again:`;
  return new Error([head, ...shown.map((problem) => `- ${problem}`), ...(rest > 0 ? [`- and ${rest} more`] : [])].join("\n"));
}
