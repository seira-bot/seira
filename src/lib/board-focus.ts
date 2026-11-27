import { useSyncExternalStore } from "react";

let pending: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Asks the Board to open the panel of this card (a BoardCard id such as "todo:<id>") the next time it shows. */
export function requestBoardCard(cardId: string): void {
  pending = cardId;
  emit();
}

/** The Board calls this once it opened the requested card. */
export function clearBoardCardRequest(): void {
  if (pending === null) return;
  pending = null;
  emit();
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => pending;

export function useBoardCardRequest(): string | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
