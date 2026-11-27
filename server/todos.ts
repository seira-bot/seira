import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { TODO_DONE_WINDOW_MS, TODO_UNDO_MS, type Todo } from "../shared/todo.ts";
import { writeFileAtomic } from "./atomic.ts";

/** A stored todo: the public fields plus what only the server needs. */
export interface TodoRecord extends Todo {
  deletedAt?: number;
  /** The conversation the bot picker was asked about this todo in, and when. */
  offeredIn?: string;
  offeredAt?: number;
  /** The last time the work on this todo showed life; the lease counts from here. */
  leaseAt?: number;
}

interface TodoMeta {
  picker?: string | null;
  pickerThreads?: Record<string, string>;
}

interface TodoFile {
  version: 1;
  todos: TodoRecord[];
  meta: TodoMeta;
}

export interface TodoBotInfo {
  id: string;
  hidden?: boolean;
  chiefOfStaff?: boolean;
}

const FILE = "todos.json";

const INTERNAL_KEYS = ["deletedAt", "offeredIn", "offeredAt", "leaseAt"] as const;

export function publicTodo(record: TodoRecord): Todo {
  const todo: Record<string, unknown> = { ...record };
  for (const key of INTERNAL_KEYS) delete todo[key];
  return structuredClone(todo) as unknown as Todo;
}

function readFile(file: string): TodoFile {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<TodoFile> | null;
    const todos = Array.isArray(raw?.todos) ? raw.todos.filter((todo): todo is TodoRecord => typeof todo?.id === "string" && typeof todo.title === "string") : [];
    const meta = raw?.meta && typeof raw.meta === "object" ? raw.meta : {};
    return { version: 1, todos, meta };
  } catch {
    return { version: 1, todos: [], meta: {} };
  }
}

export interface TodoStoreOptions {
  dataDir: string;
  now?: () => number;
  newId?: () => string;
}

/** The todos in the data folder. Every change is written at once and tells the listeners. */
export class TodoStore {
  readonly #file: string;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #data: TodoFile;
  readonly #listeners = new Set<() => void>();

  constructor(options: TodoStoreOptions) {
    this.#file = join(options.dataDir, FILE);
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? (() => randomUUID());
    this.#data = readFile(this.#file);
    this.#prune();
  }

  now(): number {
    return this.#now();
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #save(): void {
    writeFileAtomic(this.#file, JSON.stringify(this.#data) + "\n", { mode: 0o600 });
  }

  #changed(): void {
    this.#save();
    for (const listener of Array.from(this.#listeners)) {
      try {
        listener();
      } catch (error) {
        console.error("todos: change listener threw", error);
      }
    }
  }

  #prune(): boolean {
    const now = this.#now();
    const before = this.#data.todos.length;
    this.#data.todos = this.#data.todos.filter((todo) => {
      if (todo.deletedAt !== undefined) return now - todo.deletedAt <= TODO_UNDO_MS;
      if (todo.status === "done") return now - (todo.finishedAt ?? todo.updatedAt) <= TODO_DONE_WINDOW_MS;
      return true;
    });
    return this.#data.todos.length !== before;
  }

  newId(): string {
    return this.#newId();
  }

  /** Every todo that is not deleted, as stored. */
  live(): TodoRecord[] {
    if (this.#prune()) this.#save();
    return this.#data.todos.filter((todo) => todo.deletedAt === undefined).map((todo) => structuredClone(todo));
  }

  /** Every todo, deleted ones too: the bot's daily count needs them. */
  everything(): TodoRecord[] {
    return this.#data.todos.map((todo) => structuredClone(todo));
  }

  get(id: string): TodoRecord | undefined {
    const found = this.#data.todos.find((todo) => todo.id === id && todo.deletedAt === undefined);
    return found ? structuredClone(found) : undefined;
  }

  getDeleted(id: string): TodoRecord | undefined {
    const found = this.#data.todos.find((todo) => todo.id === id && todo.deletedAt !== undefined);
    return found ? structuredClone(found) : undefined;
  }

  insert(todo: TodoRecord): TodoRecord {
    this.#data.todos.push(structuredClone(todo));
    this.#changed();
    return structuredClone(todo);
  }

  /** Changes one todo. `edit` returns false to leave it as it was. */
  update(id: string, edit: (todo: TodoRecord) => boolean | void): TodoRecord | undefined {
    const found = this.#data.todos.find((todo) => todo.id === id && todo.deletedAt === undefined);
    if (!found) return undefined;
    const draft = structuredClone(found);
    if (edit(draft) === false) return structuredClone(found);
    draft.updatedAt = this.#now();
    Object.assign(found, draft);
    for (const key of Object.keys(found) as Array<keyof TodoRecord>) if (!(key in draft)) delete found[key];
    this.#changed();
    return structuredClone(found);
  }

  /** Compare-and-set: queued → working. Only the caller that gets a todo back may start it. */
  claim(id: string): TodoRecord | undefined {
    const found = this.#data.todos.find((todo) => todo.id === id && todo.deletedAt === undefined);
    if (!found || found.status !== "queued") return undefined;
    const now = this.#now();
    found.status = "working";
    found.attempts += 1;
    found.startedAt = now;
    found.leaseAt = now;
    found.updatedAt = now;
    delete found.threadId;
    delete found.question;
    delete found.stuck;
    delete found.result;
    delete found.finishedAt;
    this.#changed();
    return structuredClone(found);
  }

  /** Marks a working todo alive without telling the listeners: the lease counts from here. */
  touch(id: string, at: number): void {
    const found = this.#data.todos.find((todo) => todo.id === id && todo.deletedAt === undefined);
    if (!found) return;
    found.leaseAt = at;
    this.#save();
  }

  remove(id: string): TodoRecord | undefined {
    const found = this.#data.todos.find((todo) => todo.id === id && todo.deletedAt === undefined);
    if (!found) return undefined;
    found.deletedAt = this.#now();
    this.#changed();
    return structuredClone(found);
  }

  restore(id: string): TodoRecord | undefined {
    const found = this.#data.todos.find((todo) => todo.id === id && todo.deletedAt !== undefined);
    if (!found || this.#now() - found.deletedAt! > TODO_UNDO_MS) return undefined;
    delete found.deletedAt;
    found.updatedAt = this.#now();
    this.#changed();
    return structuredClone(found);
  }

  /** The rank that puts a todo last in a bot's Up next. */
  endRank(botId: string | undefined): number {
    const ranks = this.#data.todos.filter((todo) => todo.deletedAt === undefined && todo.botId === botId && todo.status === "queued").map((todo) => todo.rank);
    return ranks.length ? Math.max(...ranks) + 1 : 1;
  }

  /** The rank that puts a todo in front of `beforeId`; undefined when that todo is not queued for `botId`. */
  rankBefore(botId: string, beforeId: string, movingId: string): number | undefined {
    const queue = this.#data.todos
      .filter((todo) => todo.deletedAt === undefined && todo.botId === botId && todo.status === "queued" && todo.id !== movingId)
      .sort((a, b) => a.rank - b.rank);
    const at = queue.findIndex((todo) => todo.id === beforeId);
    if (at < 0) return undefined;
    const target = queue[at]!.rank;
    const previous = queue[at - 1]?.rank;
    return previous === undefined ? target - 1 : (previous + target) / 2;
  }

  /** The first todo of a bot in line, at the front: lower than every rank there. */
  frontRank(botId: string): number {
    const ranks = this.#data.todos.filter((todo) => todo.deletedAt === undefined && todo.botId === botId && todo.status === "queued").map((todo) => todo.rank);
    return ranks.length ? Math.min(...ranks) - 1 : 1;
  }

  /** The bot picker the person chose; undefined when nobody chose, so the default applies. */
  chosenPicker(): string | null | undefined {
    return this.#data.meta.picker;
  }

  setPicker(botId: string | null): void {
    this.#data.meta.picker = botId;
    this.#changed();
  }

  pickerThread(botId: string): string | undefined {
    return this.#data.meta.pickerThreads?.[botId];
  }

  setPickerThread(botId: string, threadId: string): void {
    this.#data.meta.pickerThreads = { ...this.#data.meta.pickerThreads, [botId]: threadId };
    this.#save();
  }
}

/** The bot that hands out open todos: the one the person chose, else the visible Chief of Staff, else nobody. */
export function effectivePicker(chosen: string | null | undefined, bots: readonly TodoBotInfo[]): string | null {
  if (chosen !== undefined) return chosen !== null && bots.some((bot) => bot.id === chosen) ? chosen : null;
  return bots.find((bot) => bot.chiefOfStaff === true && bot.hidden !== true)?.id ?? null;
}

/** May this todo start now? Its time came, or the todo it waits for is done or gone. */
export function startIsReady(todo: Pick<Todo, "start">, byId: (id: string) => Pick<Todo, "status"> | undefined, now: number): boolean {
  if (todo.start.kind === "free") return true;
  if (todo.start.kind === "at") return todo.start.at <= now;
  const other = byId(todo.start.todoId);
  return other === undefined || other.status === "done";
}

/** A bot's queued todos that may start, first in line first. A repeating todo never starts through the queue. */
export function readyQueue(todos: readonly Todo[], botId: string, now: number): Todo[] {
  const byId = new Map(todos.map((todo) => [todo.id, todo]));
  return todos
    .filter((todo) => todo.botId === botId && todo.status === "queued" && !todo.routineId && !todo.repeat && startIsReady(todo, (id) => byId.get(id), now))
    .sort((a, b) => a.rank - b.rank || a.createdAt - b.createdAt);
}

export interface TodoViewer {
  bot(botId: string): boolean;
  thread(threadId: string): boolean;
}

/** A viewer sees a todo when they see its bot, if it has one, and the conversation it came from, if it has one. */
export function todoVisible(todo: Pick<Todo, "botId" | "source">, viewer: TodoViewer): boolean {
  return (!todo.botId || viewer.bot(todo.botId)) && (!todo.source || viewer.thread(todo.source.threadId));
}

export function sameTitle(a: string, b: string): boolean {
  const flat = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
  return flat(a) === flat(b);
}
