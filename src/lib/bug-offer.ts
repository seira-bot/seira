import { useSyncExternalStore } from "react";
import { api } from "@/state/api";
import type { BugDraftView } from "../../shared/bug-offer";

export type { BugDraftView };

export const fetchBugDraft = (id: string) => api<BugDraftView>(`/api/bug-reports/drafts/${encodeURIComponent(id)}`);

export const sendBugDraft = (id: string) =>
  api<BugDraftView>(`/api/bug-reports/drafts/${encodeURIComponent(id)}/send`, { method: "POST", body: "{}" });

export const dismissBugDraft = (id: string) =>
  api<void>(`/api/bug-reports/drafts/${encodeURIComponent(id)}/dismiss`, { method: "POST", body: "{}" });

export const createBugDraft = (input: { threadId: string; error: string }) =>
  api<BugDraftView>("/api/bug-reports/drafts", { method: "POST", body: JSON.stringify(input) });

const open = new Map<string, true>();
const listeners = new Set<() => void>();

export function setBugDraftOpen(id: string, value: boolean): void {
  if (value === open.has(id)) return;
  if (value) open.set(id, true);
  else open.delete(id);
  for (const notify of listeners) notify();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** Whether the draft panel under a line is open. The row's own button and the panel share this. */
export function useBugDraftOpen(id: string): boolean {
  return useSyncExternalStore(subscribe, () => open.has(id), () => false);
}
