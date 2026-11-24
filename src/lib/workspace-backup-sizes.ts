import { intlLocale } from "@/lib/i18n";

/** The size report of the computer that makes the backup: bytes for each part of the data folder. */
export interface WorkspaceBackupSizes {
  parts: Record<string, number>;
  total: number;
  /** The parts an export may leave out. Today only "work-folders". */
  canLeaveOut: string[];
}

/** Parts in the order that the form shows them. A part that this app does not know comes last. */
const PART_ORDER = ["chats", "memory", "attachments", "work-folders", "other"];

const whole = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Checks the reply of `GET /api/workspace-backup/sizes`. Anything else (an older server, a bad shape) gives null. */
export function readBackupSizes(value: unknown): WorkspaceBackupSizes | null {
  if (!value || typeof value !== "object") return null;
  const { parts, total, canLeaveOut } = value as Record<string, unknown>;
  if (!parts || typeof parts !== "object" || Array.isArray(parts) || !whole(total) || !Array.isArray(canLeaveOut)) return null;
  const entries = Object.entries(parts as Record<string, unknown>);
  if (!entries.every(([, bytes]) => whole(bytes))) return null;
  return { parts: Object.fromEntries(entries) as Record<string, number>, total, canLeaveOut: canLeaveOut.filter((part): part is string => typeof part === "string") };
}

export function sortedBackupParts(sizes: WorkspaceBackupSizes): string[] {
  const rank = (part: string) => { const index = PART_ORDER.indexOf(part); return index < 0 ? PART_ORDER.length : index; };
  return Object.keys(sizes.parts).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** The total without the parts that are switched off. */
export function totalWithout(sizes: WorkspaceBackupSizes, leaveOut: readonly string[]): number {
  return Object.entries(sizes.parts).reduce((sum, [part, bytes]) => leaveOut.includes(part) ? sum : sum + bytes, 0);
}

/**
 * True when a new backup's summary lists every part that the person chose to leave out (always true for no choice).
 * A summary without `leftOut`, or one that misses a chosen part, does not confirm the choice.
 */
export function leftOutConfirmed(summary: { leftOut?: unknown } | null | undefined, chosen: readonly string[]): boolean {
  if (chosen.length === 0) return true;
  const left = summary?.leftOut;
  return Array.isArray(left) && chosen.every((part) => left.includes(part));
}

export function backupSizeText(bytes: number): string {
  const format = (value: number, digits: number) => new Intl.NumberFormat(intlLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  if (bytes < 1024) return `${format(bytes, 0)} B`;
  if (bytes < 1024 ** 2) return `${format(bytes / 1024, 1)} KB`;
  if (bytes < 1024 ** 3) return `${format(bytes / 1024 ** 2, 1)} MB`;
  return `${format(bytes / 1024 ** 3, 1)} GB`;
}
