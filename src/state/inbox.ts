// The person's inbox as the sidebar's row, its panel and a team's card in the chat show it. One copy of the server's list,
// read again whenever what it depends on changes, and the panel's own place (open, the line read). A server older than this
// page has none off a team: it answers 404, and the sidebar falls back to what it showed before.
import { useEffect, useSyncExternalStore } from "react";
import type { InboxRow, InboxView } from "../../shared/inbox";
import { api } from "./api";
import { randomUuid } from "../lib/random-uuid";
import { isNews } from "../components/inbox/inbox-kind";

type InboxTaskLike = { threadId: string; inbox?: true; openAsks?: number; inboxChangedAt?: number };

/** What the list depends on, from the person's own inbox task; null when they have none. */
export function inboxVersion(bots: ReadonlyArray<{ id: string; tasks?: readonly InboxTaskLike[] }>): string | null {
  for (const bot of bots) {
    const task = bot.tasks?.find((one) => one.inbox);
    if (task) return `${bot.id}:${task.threadId}:${task.inboxChangedAt ?? 0}:${task.openAsks ?? 0}`;
  }
  return null;
}

function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) { value = next; for (const listener of listeners) listener(); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

const list = store<InboxView | null>(null);
export const currentInbox = list.get;
export const useInboxView = (): InboxView | null => useSyncExternalStore(list.subscribe, list.get, list.get);
const hasList = () => list.get() !== null;
export const useInboxReady = (): boolean => useSyncExternalStore(list.subscribe, hasList, hasList);

export type InboxSupport = "unknown" | "yes" | "no";
const support = store<InboxSupport>("unknown");
export const useInboxSupport = (): InboxSupport => useSyncExternalStore(support.subscribe, support.get, support.get);
/** Tests and previews say what the server does. */
export const setInboxSupport = support.set;
/** Tests and previews show a list of their own. */
export const setInboxView = (view: InboxView | null): void => { list.set(view); support.set(view ? "yes" : "unknown"); };

// Every read and every change here takes the next number; a list from the server lands only if nothing later was shown,
// so an older answer never moves a row back.
let sent = 0, shown = 0;
const show = (seq: number, view: InboxView) => {
  if (seq < shown) return;
  shown = seq;
  list.set(view);
  support.set("yes");
};

let reading: Promise<void> | null = null;
let readAgain = false;
/** Reads the list now, or once more after the read on its way, so the newest answer always lands last. */
export function refreshInbox(): Promise<void> {
  if (reading) { readAgain = true; return reading; }
  reading = (async () => {
    try {
      do {
        readAgain = false;
        const seq = ++sent;
        const view = await api<InboxView>("/api/inbox", { background: true }).catch((error: unknown) => {
          if ((error as { status?: number }).status === 404) { list.set(null); support.set("no"); }
          return null;
        });
        if (view && Array.isArray(view.rows)) show(seq, view);
      } while (readAgain);
    } finally {
      reading = null;
    }
  })();
  return reading;
}

/** A message is sorted a moment after it lands; one more read this long after a change shows that verdict. */
const SORT_READ_MS = 5_000;

/** Keeps the list in step with what it depends on, and catches up when the window comes back. A server without an inbox is
 * not asked again. */
export function useInboxLoader(version: string): void {
  useEffect(() => {
    if (support.get() === "no") return;
    void refreshInbox();
    const later = setTimeout(() => { if (support.get() !== "no") void refreshInbox(); }, SORT_READ_MS);
    return () => clearTimeout(later);
  }, [version]);
  useEffect(() => {
    const again = () => { if (support.get() !== "no") void refreshInbox(); };
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, []);
}

const patchRow = (id: string, patch: Partial<InboxRow>) => {
  shown = ++sent;
  const view = list.get();
  if (view) list.set({ ...view, rows: view.rows.map((row) => (row.id === id ? { ...row, ...patch } : row)) });
};

/** Tells the server; if it can't be told, the row goes back to how it was (`undo`) and the list is read again. */
async function mark(id: string, what: "read" | "done", undo: Partial<InboxRow>): Promise<void> {
  const seq = ++sent;
  const view = await api<InboxView>(`/api/inbox/${id}/${what}`, { method: "POST", background: true }).catch(() => null);
  if (view && Array.isArray(view.rows)) return show(seq, view);
  patchRow(id, undo);
  void refreshInbox();
}

/** The person read a line: it is no longer bold. */
export function readInboxRow(row: Pick<InboxRow, "id" | "unread">): void {
  if (!row.unread) return;
  patchRow(row.id, { unread: false });
  void mark(row.id, "read", { unread: true });
}

const marking = store(false);
export const useInboxMarkingAll = (): boolean => useSyncExternalStore(marking.subscribe, marking.get, marking.get);

/** The person read every line: none is bold, and no ask is answered or moves tab. */
export function markAllInboxRead(): void {
  if (marking.get()) return;
  const view = list.get();
  if (view) { shown = ++sent; list.set({ ...view, rows: view.rows.map((row) => (row.unread ? { ...row, unread: false } : row)) }); }
  const seq = ++sent;
  marking.set(true);
  void api<InboxView>("/api/inbox/read-all", { method: "POST", background: true }).catch(() => null).then((next) => {
    marking.set(false);
    if (next && Array.isArray(next.rows)) return show(seq, next);
    void refreshInbox();
  });
}

/** An ask the person just answered here: it leaves the list at once, before the server's next read says so. */
export const settleInboxRow = (row: Pick<InboxRow, "id">): void => patchRow(row.id, { tab: "done", unread: false });

/** The person is done with a line of news: it moves to Done. */
export function doneInboxRow(row: Pick<InboxRow, "id">): void {
  const before = list.get()?.rows.find((one) => one.id === row.id);
  patchRow(row.id, { tab: "done", unread: false });
  void mark(row.id, "done", before ? { tab: before.tab, unread: before.unread } : {});
}

/** The person says a line is no decision: its mark goes at once; if the server can't be told, the mark comes back and the
 * list is read again. */
export async function notDecisionInboxRow(row: Pick<InboxRow, "id">): Promise<void> {
  patchRow(row.id, { decision: undefined });
  const seq = ++sent;
  const view = await api<InboxView>(`/api/inbox/${row.id}/not-decision`, { method: "POST", background: true }).catch(() => null);
  if (view && Array.isArray(view.rows)) return show(seq, view);
  patchRow(row.id, { decision: true });
  void refreshInbox();
}

/** Tells the server these lines are done, or with no ids all news; on failure each row goes back and the list is read again. */
async function markDoneMany(ids: string[] | null, before: Map<string, Partial<InboxRow>>): Promise<void> {
  const seq = ++sent;
  const view = await api<InboxView>("/api/inbox/done-all", { method: "POST", background: true, body: JSON.stringify(ids ? { ids } : {}) }).catch(() => null);
  if (view && Array.isArray(view.rows)) return show(seq, view);
  for (const [id, undo] of before) patchRow(id, undo);
  void refreshInbox();
}

const moveToDone = (match: (row: InboxRow) => boolean): Map<string, Partial<InboxRow>> => {
  const view = list.get();
  const before = new Map<string, Partial<InboxRow>>();
  if (!view) return before;
  for (const row of view.rows) if (match(row)) before.set(row.id, { tab: row.tab, unread: row.unread });
  shown = ++sent;
  list.set({ ...view, rows: view.rows.map((row) => (before.has(row.id) ? { ...row, tab: "done", unread: false } : row)) });
  return before;
};

/** The person is done with several lines of news, such as a group's: they move to Done together. */
export function doneInboxRows(rows: ReadonlyArray<Pick<InboxRow, "id">>): void {
  const ids = rows.map((row) => row.id);
  if (!ids.length) return;
  const named = new Set(ids);
  void markDoneMany(ids, moveToDone((row) => named.has(row.id)));
}

/** The person is done with all news: decisions and open asks stay. */
export function doneAllInboxNews(): void {
  void markDoneMany(null, moveToDone(isNews));
}

/** A reply to a line of news that waits on one: it goes back where the line came from, as a Reply in the chat does. */
export async function replyToInboxRow(view: Pick<InboxView, "botId" | "threadId">, row: Pick<InboxRow, "id" | "origin">, text: string): Promise<void> {
  const origin = view.threadId ? null : row.origin;
  const path = origin?.groupId ? `/api/groups/${origin.groupId}/messages` : `/api/bots/${origin?.botId ?? view.botId}/messages`;
  await api(path, { method: "POST", body: JSON.stringify({ text, threadId: origin?.threadId ?? view.threadId, replyToId: row.id, sendId: randomUuid() }) });
  void refreshInbox();
}

export interface InboxPanelState { open: boolean; reading: string | null; wide?: boolean }
const panel = store<InboxPanelState>({ open: false, reading: null });
export const useInboxPanel = (): InboxPanelState => useSyncExternalStore(panel.subscribe, panel.get, panel.get);
export const currentInboxPanel = panel.get;

const summarizing = store(false);
export const useInboxSummarizing = (): boolean => useSyncExternalStore(summarizing.subscribe, summarizing.get, summarizing.get);
export const currentInboxSummarizing = summarizing.get;

/** Unread news that the summary on hand does not cover. */
const SUMMARY_MIN_UNREAD = 5;
const unsummarizedNews = (view: InboxView): number => {
  const covered = new Set(view.summary?.covers);
  return view.rows.filter((row) => isNews(row) && row.unread && !covered.has(row.id)).length;
};

/** Asks for a summary of the news and shows the inbox it comes back in; `force` writes one even when little is unread. If
 * the ask fails, only the waiting note goes. */
export async function requestInboxSummary(force = false): Promise<void> {
  if (summarizing.get()) return;
  const seq = ++sent;
  summarizing.set(true);
  const view = await api<InboxView>("/api/inbox/summary", { method: "POST", background: true, body: JSON.stringify({ force }) }).catch(() => null);
  summarizing.set(false);
  if (!view || !Array.isArray(view.rows)) return;
  if (seq < shown) void refreshInbox();
  else show(seq, view);
}

const withoutSummary = (view: InboxView): InboxView => ({ botId: view.botId, threadId: view.threadId, rows: view.rows, anchor: view.anchor, ...(view.summarizer ? { summarizer: view.summarizer } : {}) });

/** The person hides the summary: it goes at once; if the server can't be told, the list is read again. */
export async function hideInboxSummary(wrong: boolean): Promise<void> {
  const view = list.get();
  if (view?.summary) { shown = ++sent; list.set(withoutSummary(view)); }
  const seq = ++sent;
  const next = await api<InboxView>("/api/inbox/summary/hide", { method: "POST", background: true, body: JSON.stringify({ wrong }) }).catch(() => null);
  if (next && Array.isArray(next.rows)) return show(seq, next);
  void refreshInbox();
}

/** The person picks who writes the summary, or none: the choice shows at once; if the server can't be told, the list is read
 * again. */
export async function setInboxSummarizer(botId: string | null): Promise<void> {
  const view = list.get();
  if (view?.summarizer) { shown = ++sent; list.set({ ...view, summarizer: { botId } }); }
  const seq = ++sent;
  const next = await api<InboxView>("/api/inbox/summarizer", { method: "POST", background: true, body: JSON.stringify({ botId }) }).catch(() => null);
  if (next && Array.isArray(next.rows)) return show(seq, next);
  void refreshInbox();
}

let summaryAsked = false;
/** Once each time the panel opens, with a summarizer chosen and enough unread news outside the summary. */
function askSummaryOnce(): void {
  const view = list.get();
  if (summaryAsked || !panel.get().open || !view?.summarizer?.botId || unsummarizedNews(view) < SUMMARY_MIN_UNREAD) return;
  summaryAsked = true;
  void requestInboxSummary();
}

/** Opens the inbox in the right panel: its list, or straight on one line. */
export function openInbox(at: { reading?: string } = {}): void {
  if (!panel.get().open) summaryAsked = false;
  panel.set({ ...panel.get(), open: true, reading: at.reading ?? null });
  void refreshInbox().then(askSummaryOnce);
}
export const closeInbox = (): void => panel.set({ ...panel.get(), open: false, reading: null });
export const readInboxLine = (id: string | null): void => panel.set({ ...panel.get(), reading: id });
/** The panel at its usual width or wider, for a long message. */
export const widenInbox = (wide: boolean): void => panel.set({ ...panel.get(), wide });
