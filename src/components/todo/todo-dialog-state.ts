import { useSyncExternalStore } from "react";

import type { TodoSource } from "../../../shared/todo";

export interface TodoDialogSeed {
  /** Set by openTodoDialog; a new value remounts the dialog. */
  nonce: number;
  title: string;
  note: string;
  /** null: any bot. */
  botId: string | null;
  who: string;
  at: number;
  source: TodoSource;
}

let seed: TodoDialogSeed | null = null;
let opened = 0;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

export function openTodoDialog(next: Omit<TodoDialogSeed, "nonce">): void {
  seed = { ...next, nonce: ++opened };
  emit();
}

export function closeTodoDialog(): void {
  if (!seed) return;
  seed = null;
  emit();
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useTodoDialogSeed = (): TodoDialogSeed | null => useSyncExternalStore(subscribe, () => seed, () => null);
