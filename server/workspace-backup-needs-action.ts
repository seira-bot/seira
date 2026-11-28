import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NEEDS_ACTION_KINDS, type WorkspaceNeedsAction, type WorkspaceNeedsActionKind } from "../shared/workspace-backup.ts";

/** The receipt's "needs action" list. Each item is a fixed kind and a count, nothing else: no name, address, path or secret.
 * A kind is counted only from restored data that a restore may read. A kind with no such source is left out, not guessed:
 * saved credentials, engine sign-ins, MCP servers and website logins are not in a backup, so they have no kind here. */
const FILE = "needs-action.json";
const MAX_COUNT = 1_000_000;
/** Which restored file holds the records, which list in it, and which field says a record is on. */
const SOURCES: Record<WorkspaceNeedsActionKind, { file: string; list: string }> = {
  "routines-on": { file: "routines.json", list: "routines" },
  "webhooks-on": { file: "webhooks.json", list: "webhooks" },
  "app-automations-on": { file: "app-triggers.json", list: "triggers" },
};

function onCount(path: string, list: string): number {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    const records = value && typeof value === "object" ? (value as Record<string, unknown>)[list] : undefined;
    return Array.isArray(records) ? records.filter((item) => item && typeof item === "object" && (item as { enabled?: unknown }).enabled === true).length : 0;
  } catch { return 0; }
}

/** Keeps only items with a known kind and a whole count from 1 up; nothing else survives. */
export function cleanNeedsAction(value: unknown): WorkspaceNeedsAction[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: WorkspaceNeedsAction[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { kind, count } = item as { kind?: unknown; count?: unknown };
    if (typeof kind !== "string" || !(NEEDS_ACTION_KINDS as readonly string[]).includes(kind) || seen.has(kind)) continue;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > MAX_COUNT) continue;
    seen.add(kind);
    items.push({ kind: kind as WorkspaceNeedsActionKind, count });
  }
  return items;
}

/** Counts what the restored data holds that was on, before the restore turns it off. Run before routines are paused. */
export function recordNeedsAction(data: string, job: string): void {
  const items = NEEDS_ACTION_KINDS.map((kind) => ({ kind, count: existsSync(join(data, SOURCES[kind].file)) ? onCount(join(data, SOURCES[kind].file), SOURCES[kind].list) : 0 }));
  writeFileSync(join(job, FILE), JSON.stringify(cleanNeedsAction(items)), { mode: 0o600 });
}

/** null when the job has no readable list, so the status does not claim "nothing to do" for it. */
export function readNeedsAction(job: string): WorkspaceNeedsAction[] | null {
  try {
    const value: unknown = JSON.parse(readFileSync(join(job, FILE), "utf8"));
    return Array.isArray(value) ? cleanNeedsAction(value) : null;
  } catch { return null; }
}
