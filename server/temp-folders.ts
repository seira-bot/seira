// A temp folder that a process makes must not outlive the process. The folder carries the id of its owner, goes at exit,
// and a later process removes the folders of an owner that is gone (a kill, a crash or a power loss skips the exit hook).
import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A folder of a dead owner younger than this stays: a clock or a process-id space that this process cannot see must not cost a live folder. */
export const ORPHAN_MIN_AGE_MS = 10 * 60 * 1000;

const atExit = new Set<string>();
let exitHookSet = false;

function removeAtExit(): void {
  for (const path of atExit) {
    try { rmSync(path, { recursive: true, force: true }); } catch {}
  }
  atExit.clear();
}

/** Makes `<prefix><pid>-<random>` in tmpdir() and removes it when this process exits normally. */
export function makeOwnedTempFolder(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), `${prefix}${process.pid}-`));
  atExit.add(path);
  if (!exitHookSet) {
    exitHookSet = true;
    process.once("exit", removeAtExit);
  }
  return path;
}

/** The caller removed the folder itself: the exit hook no longer has to. */
export function releaseOwnedTempFolder(path: string): void {
  atExit.delete(path);
}

/** Removes a folder that makeOwnedTempFolder made. A folder that stays (a locked file) is left to the exit hook. */
export function removeOwnedTempFolder(path: string): boolean {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    return false;
  }
  releaseOwnedTempFolder(path);
  return true;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists and belongs to someone else. Only ESRCH says that it is gone.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export interface OrphanSweepOptions {
  /** The folder that holds the candidates. */
  dir?: string;
  now?: number;
  minAgeMs?: number;
  /** The owner of a folder must be this user. A host without user ids (Windows) skips the check. */
  uid?: number;
  isAlive?: (pid: number) => boolean;
  remove?: (path: string) => void;
}

export interface OrphanSweepResult {
  removed: string[];
  failed: { path: string; reason: string }[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Removes the folders `<prefix><pid>-<random>` whose owner is not running and that are old enough. A name without an
 * owner (a folder of an older version, or another tool) stays: nothing says that its maker is gone. A "seira-" prefix also
 * matches the same name with "omb-", the name before v0.1.182.
 */
export function sweepOrphanedTempFolders(prefix: string, options: OrphanSweepOptions = {}): OrphanSweepResult {
  const dir = options.dir ?? tmpdir();
  const now = options.now ?? Date.now();
  const minAgeMs = options.minAgeMs ?? ORPHAN_MIN_AGE_MS;
  const uid = options.uid ?? process.getuid?.();
  const isAlive = options.isAlive ?? processIsAlive;
  const remove = options.remove ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  const result: OrphanSweepResult = { removed: [], failed: [] };
  const prefixes = prefix.startsWith("seira-") ? [prefix, `omb-${prefix.slice("seira-".length)}`] : [prefix];
  const own = new RegExp(`^(?:${prefixes.map(escapeRegExp).join("|")})(\\d+)-[A-Za-z0-9]{6}$`);
  let names: string[];
  try { names = readdirSync(dir); } catch { return result; }
  for (const name of names) {
    const match = own.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    const path = join(dir, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory()) continue;
      if (uid !== undefined && stat.uid !== uid) continue;
      if (now - stat.mtimeMs < minAgeMs) continue;
      if (pid === process.pid || isAlive(pid)) continue;
      remove(path);
      result.removed.push(path);
    } catch (error) {
      result.failed.push({ path, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

const swept = new Set<string>();

/** One sweep for each prefix in this process, made when the process first makes a folder of that kind. */
export function sweepOrphanedTempFoldersOnce(prefix: string): void {
  if (swept.has(prefix)) return;
  swept.add(prefix);
  sweepOrphanedTempFolders(prefix);
}
