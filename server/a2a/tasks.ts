// The index of one A2A peer: which A2A task and context belong to which Seira hand-off. It lives in the peer's own folder
// as a2a-tasks.json, mode 600. It holds ids, states and refusal or failure notes, never result text.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import { NOTE_MAX, TASK_STATES, isTerminal } from "./protocol.ts";

export const TASKS_MAX = 1_000;
export const CONTEXT_ENTRIES_MAX = 1_000;
export const RETENTION_MS = 7 * 24 * 60 * 60_000;
const FILE = "a2a-tasks.json";

const sha32 = (...parts: string[]): string => createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);

/** The thread of a hand-off. The bot is part of the key, so one context id never joins the threads of two bots. */
export const threadKey = (botId: string, contextKey: string): string => sha32(botId, contextKey);

/** The id of an inbound hand-off. The same peer and message id always give the same id. */
export const frameId = (peerKey: string, messageId: string): string => sha32(peerKey, messageId);

const taskSchema = z.object({
  id: z.string().min(1).max(200),
  dir: z.enum(["in", "out"]),
  bot: z.string().min(1).max(128),
  context: z.string().max(256),
  thread: z.string().max(200),
  farTask: z.string().max(256).optional(),
  state: z.enum(TASK_STATES),
  note: z.string().max(NOTE_MAX).optional(),
  at: z.number().finite(),
}).strict();
const contextSchema = z.object({ far: z.string().max(256), inputTask: z.string().max(256).optional(), at: z.number().finite() }).strict();

export type TaskEntry = z.infer<typeof taskSchema>;
export type FarContext = { far: string; inputTask?: string };

export interface TaskIndex {
  get(id: string): TaskEntry | null;
  /** Adds the task or replaces the task with the same id. The note is cut to its limit. */
  put(entry: TaskEntry): void;
  /** Drops one task, so a request that started nothing leaves no record. */
  remove(id: string): void;
  /** How many distinct contexts the inbound tasks use. */
  contextCount(): number;
  hasContext(context: string): boolean;
  /** How many distinct threads the inbound tasks use: one for each pair of bot and context. */
  threadCount(): number;
  hasThread(thread: string): boolean;
  /** The far context stored for a thread of outbound work. */
  outOf(thread: string): FarContext | null;
  setContext(thread: string, far: string, inputTask?: string): void;
  /** Drops what is past retention and what is over the caps. Returns how many tasks it dropped. */
  prune(): number;
}

type State = { tasks: TaskEntry[]; contexts: Map<string, z.infer<typeof contextSchema>> };

function load(path: string, log: (line: string) => void): State {
  const state: State = { tasks: [], contexts: new Map() };
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return state; }
  try {
    const raw: unknown = JSON.parse(text);
    const file = z.object({ v: z.literal(1), tasks: z.array(z.unknown()), contexts: z.record(z.string(), z.unknown()) }).parse(raw);
    for (const task of file.tasks) {
      const parsed = taskSchema.safeParse(task);
      if (parsed.success) state.tasks.push(parsed.data);
    }
    for (const [thread, context] of Object.entries(file.contexts)) {
      const parsed = contextSchema.safeParse(context);
      if (parsed.success) state.contexts.set(thread, parsed.data);
    }
  } catch {
    log("a2a tasks: the record did not parse, so it starts empty");
    return { tasks: [], contexts: new Map() };
  }
  return state;
}

export function createTaskIndex(dir: string, now: () => number, log: (line: string) => void = () => {}): TaskIndex {
  const path = join(dir, FILE);
  const state = load(path, log);

  const persist = (): void => {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileAtomic(path, JSON.stringify({ v: 1, tasks: state.tasks, contexts: Object.fromEntries(state.contexts) }), { mode: 0o600 });
    } catch {
      log("a2a tasks: the record could not be saved");
    }
  };

  /** Memory only; the callers save. */
  const trim = (): number => {
    const before = state.tasks.length;
    const cutoff = now() - RETENTION_MS;
    state.tasks = state.tasks.filter((task) => !(isTerminal(task.state) && task.at < cutoff));
    if (state.tasks.length > TASKS_MAX) {
      // Over the cap, the oldest ended tasks go first, then the oldest of all.
      const byAge = [...state.tasks].sort((a, b) => a.at - b.at);
      const drop = new Set<TaskEntry>();
      let excess = state.tasks.length - TASKS_MAX;
      for (const task of byAge) if (excess > 0 && isTerminal(task.state)) { drop.add(task); excess -= 1; }
      for (const task of byAge) if (excess > 0 && !drop.has(task)) { drop.add(task); excess -= 1; }
      state.tasks = state.tasks.filter((task) => !drop.has(task));
    }
    for (const [thread, context] of state.contexts) if (context.at < cutoff) state.contexts.delete(thread);
    if (state.contexts.size > CONTEXT_ENTRIES_MAX) {
      const oldest = [...state.contexts].sort((a, b) => a[1].at - b[1].at).slice(0, state.contexts.size - CONTEXT_ENTRIES_MAX);
      for (const [thread] of oldest) state.contexts.delete(thread);
    }
    return before - state.tasks.length;
  };

  return {
    get: (id) => state.tasks.find((task) => task.id === id) ?? null,
    put(entry) {
      const task = taskSchema.parse({ ...entry, note: entry.note?.slice(0, NOTE_MAX) });
      const at = state.tasks.findIndex((existing) => existing.id === task.id);
      if (at >= 0) state.tasks[at] = task;
      else state.tasks.push(task);
      trim();
      persist();
    },
    remove(id) {
      const before = state.tasks.length;
      state.tasks = state.tasks.filter((task) => task.id !== id);
      if (state.tasks.length !== before) persist();
    },
    contextCount: () => new Set(state.tasks.filter((task) => task.dir === "in").map((task) => task.context)).size,
    hasContext: (context) => state.tasks.some((task) => task.dir === "in" && task.context === context),
    threadCount: () => new Set(state.tasks.filter((task) => task.dir === "in").map((task) => task.thread)).size,
    hasThread: (thread) => state.tasks.some((task) => task.dir === "in" && task.thread === thread),
    outOf(thread) {
      const context = state.contexts.get(thread);
      if (!context) return null;
      return context.inputTask === undefined ? { far: context.far } : { far: context.far, inputTask: context.inputTask };
    },
    setContext(thread, far, inputTask) {
      const next = contextSchema.parse(inputTask === undefined ? { far, at: now() } : { far, inputTask, at: now() });
      state.contexts.set(thread, next);
      trim();
      persist();
    },
    prune() {
      const contextsBefore = state.contexts.size;
      const dropped = trim();
      if (dropped > 0 || state.contexts.size !== contextsBefore) persist();
      return dropped;
    },
  };
}
