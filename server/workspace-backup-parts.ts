import { lstatSync, readdirSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/** The parts of the data folder that a size report lists. */
export const BACKUP_PARTS = ["chats", "memory", "attachments", "work-folders", "other"] as const;
export type BackupPart = (typeof BACKUP_PARTS)[number];

/** The parts an export may leave out. Start small: only the conversation work folders. */
export const LEAVE_OUT_PARTS = ["work-folders"] as const satisfies readonly BackupPart[];
export type LeaveOutPart = (typeof LEAVE_OUT_PARTS)[number];

const CHAT_FILES = /^(?:bots\.json|groups\.json|thread-starters\.json|sessions\.json|messages\.db(?:-wal|-shm)?|runtime\.db(?:-wal|-shm)?|workflows\.db(?:-wal|-shm)?)$/;

/** The part that a path (relative to the data folder, with "/" separators) belongs to. */
export function backupPartOf(path: string): BackupPart {
  const top = path.split("/")[0]!;
  if (top === "task-workspaces") return "work-folders";
  if (top === "attachments") return "attachments";
  if (top === "workspaces") return "memory";
  if (CHAT_FILES.test(top)) return "chats";
  return "other";
}

/** Checks a list of parts to leave out. Throws one clear message for a value that is not on the fixed list. */
export function parseLeaveOut(value: unknown): LeaveOutPart[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`The parts to leave out must be a list. Allowed: ${LEAVE_OUT_PARTS.join(", ")}.`);
  const allowed = new Set<string>(LEAVE_OUT_PARTS);
  const chosen = new Set<LeaveOutPart>();
  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item)) {
      throw new Error(`Cannot leave out "${String(item).slice(0, 60)}". Allowed: ${LEAVE_OUT_PARTS.join(", ")}.`);
    }
    chosen.add(item as LeaveOutPart);
  }
  return [...chosen];
}

/** Tells whether the export leaves a path out (relative to the data folder, "/" separators). The size report gets the export's own rule. */
export type OmitFromBackup = (path: string) => boolean;

/** Bytes of regular files for each part. Links, unreadable entries, the backup folder and dependency folders are left out,
 * and so is every path that `omit` names: pass the export's own rule so the report counts what an export would take. */
export function partSizes(root: string, leaveOut: readonly BackupPart[] = [], omit?: OmitFromBackup): Record<BackupPart, number> {
  const sizes = Object.fromEntries(BACKUP_PARTS.map((part) => [part, 0])) as Record<BackupPart, number>;
  const skip = new Set<BackupPart>(leaveOut);
  const walk = (directory: string, prefix: string) => {
    let names: string[];
    try { names = readdirSync(directory); } catch { return; }
    for (const name of names) {
      if ((!prefix && name === ".backups") || name === "node_modules") continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (omit?.(path)) continue;
      const part = backupPartOf(path);
      if (skip.has(part)) continue;
      try {
        const full = join(directory, name);
        const stat = lstatSync(full);
        if (stat.isDirectory()) walk(full, path);
        else if (stat.isFile()) sizes[part] += stat.size;
      } catch {}
    }
  };
  walk(root, "");
  return sizes;
}

/** Same result as `partSizes`, but the walk is async, so a large data folder does not block the event loop. */
export async function partSizesAsync(root: string, leaveOut: readonly BackupPart[] = [], omit?: OmitFromBackup): Promise<Record<BackupPart, number>> {
  const sizes = Object.fromEntries(BACKUP_PARTS.map((part) => [part, 0])) as Record<BackupPart, number>;
  const skip = new Set<BackupPart>(leaveOut);
  const walk = async (directory: string, prefix: string): Promise<void> => {
    let names: string[];
    try { names = await readdir(directory); } catch { return; }
    for (const name of names) {
      if ((!prefix && name === ".backups") || name === "node_modules") continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (omit?.(path)) continue;
      const part = backupPartOf(path);
      if (skip.has(part)) continue;
      try {
        const full = join(directory, name);
        const stat = await lstat(full);
        if (stat.isDirectory()) await walk(full, path);
        else if (stat.isFile()) sizes[part] += stat.size;
      } catch {}
    }
  };
  await walk(root, "");
  return sizes;
}

/** Runs one walk at a time for each folder: a call that arrives during a walk gets the result of that walk. */
export function singleFlightSizes(walk: (root: string) => Promise<Record<BackupPart, number>> = partSizesAsync): (root: string) => Promise<Record<BackupPart, number>> {
  const running = new Map<string, Promise<Record<BackupPart, number>>>();
  return (root) => {
    const active = running.get(root);
    if (active) return active;
    const started = walk(root).finally(() => running.delete(root));
    running.set(root, started);
    return started;
  };
}
