import { useEffect, useSyncExternalStore } from "react";

import type { Todo, TodoDraft, TodoList, TodoPatch } from "../../shared/todo";
import type { ServerFrame } from "../../shared/wire";
import { listenLiveFrames } from "@/lib/live-events";
import { api } from "@/state/api";

export interface TodosState {
  loaded: boolean;
  failed: boolean;
  todos: Todo[];
  picker: string | null;
}

const REREAD_MS = 400;
const LIVE_KINDS: ReadonlySet<string> = new Set(["todos", "bot"]);
const EMPTY: TodosState = { loaded: false, failed: false, todos: [], picker: null };

let state: TodosState = EMPTY;
const listeners = new Set<() => void>();
let reading: Promise<void> | null = null;
let readAgain = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let watchers = 0;
let stopListening: (() => void) | null = null;

function set(next: TodosState): void {
  state = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => state;

export function loadTodos(options: { background?: boolean } = {}): Promise<void> {
  if (reading) { readAgain = true; return reading; }
  reading = (async () => {
    try {
      do {
        readAgain = false;
        try {
          const list = await api<TodoList>("/api/todos", options.background ? { background: true } : undefined);
          set({ loaded: true, failed: false, todos: Array.isArray(list?.todos) ? list.todos : [], picker: typeof list?.picker === "string" ? list.picker : null });
        } catch {
          set({ ...state, failed: true });
        }
      } while (readAgain);
    } finally {
      reading = null;
    }
  })();
  return reading;
}

function scheduleRead(): void {
  if (timer) return;
  timer = setTimeout(() => { timer = null; void loadTodos({ background: true }); }, REREAD_MS);
}

/** Keeps the todos current while something shows them. Returns the function that stops. */
export function watchTodos(): () => void {
  watchers++;
  if (watchers === 1) {
    stopListening = listenLiveFrames({
      onFrame: (frame: ServerFrame | { kind: string }) => { if (LIVE_KINDS.has(frame.kind)) scheduleRead(); },
      onMissedFrames: scheduleRead,
    });
  }
  void loadTodos();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    watchers--;
    if (watchers > 0) return;
    stopListening?.();
    stopListening = null;
    if (timer) { clearTimeout(timer); timer = null; }
  };
}

export function useTodos(): TodosState {
  useEffect(() => watchTodos(), []);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** The todos made from one chat message, newest first. */
export function todosFromMessage(todos: readonly Todo[], messageId: string): Todo[] {
  return todos.filter((todo) => todo.source?.messageId === messageId).sort((a, b) => b.createdAt - a.createdAt);
}

function replace(changed: readonly Todo[], removed: readonly string[] = []): void {
  const byId = new Map(state.todos.map((todo) => [todo.id, todo]));
  for (const id of removed) byId.delete(id);
  for (const todo of changed) byId.set(todo.id, todo);
  set({ ...state, todos: [...byId.values()] });
}

export async function addTodos(drafts: TodoDraft[]): Promise<Todo[]> {
  const made = await api<{ todos?: Todo[] }>("/api/todos", { method: "POST", body: JSON.stringify({ todos: drafts }) });
  const todos = Array.isArray(made?.todos) ? made.todos : [];
  replace(todos);
  return todos;
}

export async function patchTodo(id: string, patch: TodoPatch): Promise<Todo> {
  const made = await api<{ todo: Todo }>(`/api/todos/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
  replace([made.todo]);
  void loadTodos({ background: true });
  return made.todo;
}

/** Starts a queued todo now, also while its bot works on something else or waits for "When I say". */
export async function startTodo(id: string): Promise<Todo> {
  const made = await api<{ todo: Todo }>(`/api/todos/${encodeURIComponent(id)}/start`, { method: "POST", body: "{}" });
  replace([made.todo]);
  return made.todo;
}

export async function deleteTodo(id: string): Promise<void> {
  await api(`/api/todos/${encodeURIComponent(id)}`, { method: "DELETE" });
  replace([], [id]);
}

/** Undo for a delete, within TODO_UNDO_MS. */
export async function restoreTodo(id: string): Promise<Todo> {
  const made = await api<{ todo: Todo }>(`/api/todos/${encodeURIComponent(id)}/restore`, { method: "POST", body: "{}" });
  replace([made.todo]);
  return made.todo;
}

/** Sets the bot that gives open todos to a bot; null means the person picks. */
export async function setTodoPicker(botId: string | null): Promise<void> {
  const before = state.picker;
  set({ ...state, picker: botId });
  try {
    await api("/api/todos/picker", { method: "PUT", body: JSON.stringify({ botId }) });
  } catch (error) {
    set({ ...state, picker: before });
    throw error;
  }
}

export function resetTodosForTest(): void {
  if (timer) clearTimeout(timer);
  timer = null; reading = null; readAgain = false; watchers = 0;
  stopListening?.(); stopListening = null;
  state = EMPTY;
  listeners.clear();
}
