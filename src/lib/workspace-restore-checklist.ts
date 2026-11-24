/** The kinds that a restore receipt can list (the server's fixed list). Anything else is dropped. */
export const NEEDS_ACTION_KINDS = ["routines-on", "webhooks-on", "app-automations-on"] as const;
export type NeedsActionKind = typeof NEEDS_ACTION_KINDS[number];

export type ChecklistItemId = NeedsActionKind | "left-behind";
/** `left-behind` counts the bots whose working folder stayed on the old computer. */
export interface ChecklistItem { id: ChecklistItemId; count: number }

const wholeCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;

/**
 * A list with no automation kind does not prove that nothing is paused: a receipt from an older restore has no list,
 * and the server reads it as an empty one. The screen then says that no item was listed and keeps the warning.
 */
export const hasAutomationItem = (items: readonly ChecklistItem[]): boolean => items.some((item) => item.id !== "left-behind");

/**
 * The checklist of one restore, from the status of the backup route. Returns null when the server has no list
 * (an older server), so the screen can show its old static line. The screen draws only a fixed label and a whole
 * count for each kind: a name, a path or other text in an item is never read.
 */
export function readRestoreChecklist(status: { needsAction?: unknown; leftBehind?: unknown }): ChecklistItem[] | null {
  if (!Array.isArray(status.needsAction)) return null;
  const seen = new Set<string>();
  const items: ChecklistItem[] = [];
  for (const entry of status.needsAction) {
    if (!entry || typeof entry !== "object") continue;
    const { kind, count } = entry as Record<string, unknown>;
    if (!(NEEDS_ACTION_KINDS as readonly unknown[]).includes(kind) || !wholeCount(count) || seen.has(kind as string)) continue;
    seen.add(kind as string);
    items.push({ id: kind as NeedsActionKind, count });
  }
  const left = status.leftBehind as { bots?: unknown } | null | undefined;
  if (left && typeof left === "object" && wholeCount(left.bots)) items.push({ id: "left-behind", count: left.bots });
  return items;
}

const keyOf = (restoreId: string) => `seira-restore-checklist:${restoreId}`;

/**
 * The items that the person marked as done for this restore, on this device only. The storage is read inside the
 * `try`: a browser that blocks local storage can throw when the `localStorage` property is read, and that must not
 * reach the caller.
 */
export function readDoneItems(restoreId: string, storage?: Pick<Storage, "getItem">): string[] {
  try {
    const value: unknown = JSON.parse((storage ?? localStorage).getItem(keyOf(restoreId)) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}

export function writeDoneItems(restoreId: string, done: readonly string[], storage?: Pick<Storage, "setItem">): void {
  try { (storage ?? localStorage).setItem(keyOf(restoreId), JSON.stringify(done)); } catch { /* storage can be blocked: the marks last until reload */ }
}
