// Announcements: the cards from the project's announcements file (src/lib/announcements.ts), newest first, and the red
// dot while one is newer than the person last looked.
import { useSyncExternalStore } from "react";
import type { OnboardingStatus } from "@/lib/onboarding";
import { dismissNotice, noticeSeen } from "@/lib/notices";
import type { ConfigStatus } from "@/state/config-status";
import { api } from "@/state/store";
import { ANNOUNCEMENTS_READ_HINT, announcementsReadAt as readMarkOf } from "../../shared/cloud-hints";
import type { AnnouncementCard } from "../../shared/announcements";

/** Where the person stands before they ever open Announcements: a card dated before this counts as read. */
export const READ_BASELINE = Date.parse("2026-11-11");

export interface HistoryItem { id: string; at: number; card: AnnouncementCard }

/** Newest first; a card is dated by its `starts`, else by when its file last changed, else now. */
export function announcementHistory({ cards, feedUpdatedAt, now }: { cards: readonly AnnouncementCard[]; feedUpdatedAt: number | null; now: number }): HistoryItem[] {
  const items: HistoryItem[] = cards.map(card => ({ id: card.id, at: card.starts ? Date.parse(card.starts) : feedUpdatedAt ?? now, card }));
  return items.map((item, order) => ({ item, order })).sort((a, b) => b.item.at - a.item.at || a.order - b.order).map(({ item }) => item);
}

// ---- When the person last opened Announcements: this browser, this desktop's record for every page of its window, and
// the place's record (on a Team Cloud, the person's own). The newest of them counts.

const READ_KEY = "omb.announcements.read-at";
const stored = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
const store = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch {} };

let version = 0;
const listeners = new Set<() => void>();
const changed = () => { version++; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
/** Re-renders when this page records something here (localStorage does not tell it). */
export function useAnnouncementRecord(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

export const readMark = (at: number) => `announcements-read-${Math.floor(at)}`;

export interface PersonRecord {
  record: OnboardingStatus | undefined;
  /** This desktop's record (DesktopNoticesState.seen); empty in a browser. */
  desktopSeen: readonly string[];
}

export function announcementsReadAt({ record, desktopSeen }: PersonRecord): number {
  const local = Number(stored(READ_KEY));
  const marks = [Number.isSafeInteger(local) && local > 0 ? local : null, readMarkOf(record?.hintsSeen ?? []), readMarkOf(desktopSeen)].filter((at): at is number => at !== null);
  return marks.length ? Math.max(...marks) : READ_BASELINE;
}

export function itemSeen(item: HistoryItem, { record, desktopSeen }: PersonRecord): boolean {
  const key = `announcement:${item.id}`;
  return noticeSeen(record, key) || desktopSeen.includes(key);
}

/** The dot: something here is newer than the person's last look and they have not seen it. */
export function announcementsUnread(items: readonly HistoryItem[], person: PersonRecord): boolean {
  const readAt = announcementsReadAt(person);
  return items.some(item => item.at > readAt && !itemSeen(item, person));
}

export interface RecordWriter {
  /** A Team Cloud's page: the person's own record (PUT /api/me/welcome), as members cannot change the team's. */
  team: boolean;
  desktop?: { seen(id: string): Promise<void> };
  /** The place's new record, once saved. */
  saved: (config: ConfigStatus) => void;
}

function savePersonal(hint: string, hintsSeen: string[] | null, writer: RecordWriter): void {
  void writer.desktop?.seen(hint).catch(() => {});
  const saving = writer.team
    ? api("/api/me/welcome", { method: "PUT", body: JSON.stringify({ hints: [hint] }) }).then(() => api<ConfigStatus>("/api/config"))
    : hintsSeen ? api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ onboarding: { hintsSeen } }) }) : null;
  void saving?.then(writer.saved).catch(() => {});
}

/** The person opened Announcements now: the dot goes, here and on their other pages. */
export function markAnnouncementsRead(now: number, record: OnboardingStatus | undefined, writer: RecordWriter): void {
  const mark = readMark(now), hints = record?.hintsSeen ?? [];
  store(READ_KEY, String(Math.floor(now)));
  const next = [...hints.filter(hint => !ANNOUNCEMENTS_READ_HINT.test(hint)), mark];
  savePersonal(mark, next.length > 100 ? null : next, writer);
  changed();
}

/** The person closed (or used) a built-in popup that is theirs alone, as the Teams one is on a Team Cloud. */
export function rememberNoticeSeen(id: string, record: OnboardingStatus | undefined, writer: RecordWriter): void {
  const patch = dismissNotice(record, id);
  savePersonal(id, writer.team ? [] : patch?.onboarding.hintsSeen ?? null, writer);
  changed();
}

