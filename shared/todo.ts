/** A todo: work a person or a bot wrote down for a bot, or for whichever bot fits. */

/** open: no bot yet. queued: waits in its bot's Up next (or in Scheduled, see `start`). working: its bot works on it.
 * needs-you: its bot asked the person something, the work stopped, or no bot could be picked. done: finished. */
export type TodoStatus = "open" | "queued" | "working" | "needs-you" | "done";

/** When a queued todo may start: as soon as its bot is free, after another todo is done, or at a time. */
export type TodoStart =
  | { kind: "free" }
  | { kind: "after"; todoId: string }
  | { kind: "at"; at: number };

/** Repeats through a routine. `weekdays` uses 0 for Sunday; empty means every day. `time` is "HH:MM", local time. */
export interface TodoRepeat {
  time: string;
  weekdays: number[];
}

export type TodoMaker = { kind: "person"; name: string } | { kind: "bot"; botId: string };

/** The chat message a todo was made from. `quote` is the selected text, or the start of the message. */
export interface TodoSource {
  threadId: string;
  messageId?: string;
  /** The bot whose conversation it is; absent for a group chat. */
  botId?: string;
  groupId?: string;
  quote?: string;
}

export interface Todo {
  id: string;
  /** Plain text, at most TODO_TITLE_CHARS. */
  title: string;
  /** More detail for the bot, at most TODO_NOTE_CHARS. */
  note?: string;
  /** The bot that does it; absent while the todo is open. */
  botId?: string;
  status: TodoStatus;
  start: TodoStart;
  /** Order in the bot's Up next: lower starts first. */
  rank: number;
  madeBy: TodoMaker;
  /** The bot picker gave this todo to its bot, with a one-line reason. */
  pickedBy?: { botId: string; reason: string };
  source?: TodoSource;
  /** The conversation the bot works in; set when the todo starts. */
  threadId?: string;
  /** A repeating todo is a routine; its runs show on the Board as routine cards. */
  routineId?: string;
  repeat?: TodoRepeat;
  /** The bot's own question while the status is needs-you. */
  question?: string;
  /** Why the todo is in needs-you when its bot asked nothing. stopped: the work stopped TODO_MAX_ATTEMPTS times.
   * unassigned: the bot picker gave it to no bot. */
  stuck?: "stopped" | "unassigned";
  /** The bot's last reply, once done. */
  result?: string;
  /** How many times the work started. After TODO_MAX_ATTEMPTS the todo goes to needs-you. */
  attempts: number;
  /** 0 for a person's todo; a todo a bot adds while it works on a todo is one deeper. */
  depth: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Who moved it to Done by hand. */
  closedBy?: TodoMaker;
}

/** GET /api/todos. `picker` is the bot that gives open todos to a bot, or null when the person picks. */
export interface TodoList {
  todos: Todo[];
  picker: string | null;
}

/** What POST /api/todos takes for each new todo. `afterIndex` points at an earlier draft of the same request. */
export interface TodoDraft {
  title: string;
  note?: string;
  botId?: string;
  start?: TodoStart;
  afterIndex?: number;
  repeat?: TodoRepeat;
  source?: TodoSource;
}

/** PATCH /api/todos/:id. `botId: null` makes the todo open again. `beforeId` moves it in front of another todo of the
 * same bot; `beforeId: null` moves it to the end of that bot's Up next. */
export interface TodoPatch {
  title?: string;
  note?: string | null;
  botId?: string | null;
  start?: TodoStart;
  beforeId?: string | null;
  status?: "queued" | "done";
}

/** The per-bot choice in the bot panel. Absent on a bot means "auto". */
export type StartsTodos = "auto" | "manual";

export const TODO_TITLE_CHARS = 120;
export const TODO_NOTE_CHARS = 2000;
export const TODO_QUOTE_CHARS = 500;
export const TODO_RESULT_CHARS = 2000;
/** A Working todo whose conversation does no work for this long goes back to Up next. */
export const TODO_LEASE_MS = 10 * 60_000;
export const TODO_MAX_ATTEMPTS = 3;
/** A bot may add at most this many todos in 24 hours. */
export const TODO_BOT_DAILY_MAX = 20;
/** A bot working on a todo of this depth may not add another todo. */
export const TODO_MAX_DEPTH = 3;
/** One todo_add call or one POST adds at most this many. */
export const TODO_BATCH_MAX = 10;
/** Done todos older than this leave the list. */
export const TODO_DONE_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** A deleted todo can come back with Undo for this long. */
export const TODO_UNDO_MS = 24 * 60 * 60_000;
