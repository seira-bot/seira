import { lstatSync, readdirSync, statfsSync } from "node:fs";
import { join } from "node:path";

export type FreeSpace = (path: string) => { bavail: number | bigint; bsize: number | bigint };

const MARGIN_BYTES = 64 * 1024 ** 2;

/** Bytes of regular files under a folder; links, unreadable entries, the backup folder and dependency folders are left out. */
export function dataBytes(root: string): number {
  let total = 0;
  const walk = (directory: string, top: boolean) => {
    let names: string[];
    try { names = readdirSync(directory); } catch { return; }
    for (const name of names) {
      if ((top && name === ".backups") || name === "node_modules") continue;
      try {
        const path = join(directory, name);
        const stat = lstatSync(path);
        if (stat.isDirectory()) walk(path, false);
        else if (stat.isFile()) total += stat.size;
      } catch {}
    }
  };
  walk(root, true);
  return total;
}

/** The snapshot copy and the encrypted archive each hold the data once. */
export function backupSpaceNeeded(bytes: number): number {
  return bytes * 2 + MARGIN_BYTES;
}

export function sizeText(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** Throws before any copy when the disk holding `directory` is too full; a failed disk query lets the backup go on. */
export function assertBackupSpace(directory: string, dataRoot: string, statfs: FreeSpace = statfsSync): void {
  let free: number;
  try {
    const stats = statfs(directory);
    free = Number(stats.bavail) * Number(stats.bsize);
  } catch { return; }
  if (!Number.isFinite(free)) return;
  const needed = backupSpaceNeeded(dataBytes(dataRoot));
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
