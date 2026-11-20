import { Archive, Bug, Layers, MessagesSquare, Mic, Package, Plug, Sparkles, Timer, Users, type LucideIcon } from "lucide-react";
import type { LocaleKey } from "@/locales";
import { RELEASES_URL } from "@/lib/app-links";

export type ReleaseNoteItem = { id: string; icon: LucideIcon };
export type ReleaseNote = { version: string; items: readonly ReleaseNoteItem[] };
export type VersionRecord = { first: string; last: string; before: string | null };
export type ReleaseNotesView = { version: string; from: string | null; items: ReleaseNoteItem[] };

/** Newest first. A version with no entry here shows no popup. */
export const RELEASE_NOTES: readonly ReleaseNote[] = [
  { version: "0.1.181", items: [
    { id: "aiPool", icon: Layers },
    { id: "connectOneClick", icon: Plug },
    { id: "backupName", icon: Archive },
    { id: "claudeAccounts", icon: Users },
    { id: "whatsNew", icon: Sparkles },
    { id: "flatpakEngine", icon: Package },
  ] },
  { version: "0.1.180", items: [
    { id: "bugReport", icon: Bug },
    { id: "longChats", icon: MessagesSquare },
    { id: "fasterStart", icon: Timer },
    { id: "liveYes", icon: Mic },
  ] },
];

export const MAX_RELEASE_NOTE_ITEMS = 6;
export const VERSIONS_KEY = "seira.versions";

export const releaseNoteKeys = (id: string) =>
  ({ title: `releaseNotes.items.${id}.title`, body: `releaseNotes.items.${id}.body` }) as { title: LocaleKey; body: LocaleKey };

export const releaseNotesHint = (version: string) => `release-notes:${version}`;
export const releaseNotesUrl = (version: string) => `${RELEASES_URL}/tag/v${version}`;

const numeric = (version: string): number[] | null => {
  const parts = version.trim().replace(/^v/, "").split(".");
  return parts.every(part => /^\d+$/.test(part)) ? parts.map(Number) : null;
};

/** Negative when `a` is older than `b`, positive when newer; null when either is not a numeric version such as "0.1.180". */
export function compareVersions(a: string, b: string): number | null {
  const left = numeric(a), right = numeric(b);
  if (!left || !right) return null;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

const isRecord = (value: unknown): value is VersionRecord => {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.first === "string" && typeof item.last === "string" && (item.before === null || typeof item.before === "string");
};

function readRecord(): VersionRecord | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(VERSIONS_KEY) ?? "null");
    return isRecord(parsed) ? parsed : null;
  } catch { return null; }
}

function writeRecord(record: VersionRecord): void {
  try { localStorage.setItem(VERSIONS_KEY, JSON.stringify(record)); } catch {}
}

/** Keeps the versions this profile ran: `first` is "" for a profile that ran an unknown earlier version, `before` the version
 * run before `last`. Returns the record now stored; a second call with the same version changes nothing. */
export function noteVersion(current: string, usedBeforeNow: boolean): VersionRecord {
  const stored = readRecord();
  if (!stored) {
    const fresh = { first: usedBeforeNow ? "" : current, last: current, before: null };
    writeRecord(fresh);
    return fresh;
  }
  if (stored.last === current) return stored;
  const next = { ...stored, before: stored.last, last: current };
  writeRecord(next);
  return next;
}

export function releaseNotesView(record: VersionRecord, current: string, notes: readonly ReleaseNote[] = RELEASE_NOTES): ReleaseNotesView | null {
  const entry = notes.find(note => note.version === current);
  if (!entry || record.first === current) return null;
  const from = record.before !== null && (compareVersions(record.before, current) ?? 0) < 0 ? record.before : null;
  const merged = from === null ? [entry] : notes
    .filter(note => (compareVersions(note.version, from) ?? 0) > 0 && (compareVersions(note.version, current) ?? 1) <= 0)
    .sort((a, b) => (compareVersions(b.version, a.version) ?? 0));
  return { version: current, from, items: merged.flatMap(note => note.items).slice(0, MAX_RELEASE_NOTE_ITEMS) };
}
