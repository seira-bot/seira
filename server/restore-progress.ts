import { rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BEAT_EVERY_MS = 2_000;
export const RESTORE_FRESH_MS = 30_000;

let marker: string | null = null;
let lastBeat = 0;

const markerFile = (dataDir: string): string => join(dataDir, ".backups", "restore-progress");

/** The server calls this before it applies a pending restore; the launcher reads the file's age, so it must stay a plain file. */
export function beginRestoreBeat(dataDir: string): void {
  marker = markerFile(dataDir);
  lastBeat = 0;
  restoreBeat();
}

/** Cheap to call in a copy loop: it writes at most once every two seconds. A failed write never stops the restore. */
export function restoreBeat(now: () => number = Date.now): void {
  if (!marker || now() - lastBeat < BEAT_EVERY_MS) return;
  lastBeat = now();
  try { writeFileSync(marker, `${lastBeat}\n`, { mode: 0o600 }); } catch { /* progress only */ }
}

export function endRestoreBeat(): void {
  if (marker) try { rmSync(marker, { force: true }); } catch { /* progress only */ }
  marker = null;
}

/** Runs a restore's check and copy with the beat on, and turns it off when they end or fail. */
export function withRestoreBeat<T>(dataDir: string, work: () => T): T {
  beginRestoreBeat(dataDir);
  try {
    return work();
  } finally {
    endRestoreBeat();
  }
}

/** Whether a server is applying a restore in this data folder right now (the marker was touched in the last 30 s). */
export function restoreInProgress(dataDir: string, now: () => number = Date.now): boolean {
  try {
    return now() - statSync(markerFile(dataDir)).mtimeMs < RESTORE_FRESH_MS;
  } catch {
    return false;
  }
}
