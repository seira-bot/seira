import {
  TODO_BATCH_MAX, TODO_BOT_DAILY_MAX, TODO_MAX_DEPTH, TODO_NOTE_CHARS, TODO_QUOTE_CHARS, TODO_TITLE_CHARS,
  type Todo, type TodoDraft, type TodoMaker, type TodoPatch, type TodoRepeat, type TodoSource, type TodoStart,
} from "../../shared/todo.ts";
import { TEAM_AUDIENCE, type Audience } from "../audience.ts";
import { atLeast, type BotAccessLevel } from "../../shared/bot-access.ts";
import { botMayClose } from "../board.ts";
import { namesTeammate } from "../peer-roster.ts";
import { OUTSIDE, type WorkOrigin } from "../peer-provenance.ts";
import type { UsageTrigger } from "../usage-ledger.ts";
import type { TodoLaunch } from "../todo-runner.ts";
import { effectivePicker, sameTitle, todoAudienceFrom, type TodoPerson, type TodoRecord, type TodoStore } from "../todos.ts";

const DAY_MS = 24 * 60 * 60_000;
const REASON_CHARS = 200;

export class TodoError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface TodoBot {
  id: string;
  name: string;
  title?: string;
  description?: string;
  hidden?: boolean;
  chiefOfStaff?: boolean;
  section?: string;
}

export interface TodoRoutines {
  create(input: { name: string; prompt: string; botId: string; schedule: { type: "daily"; time: string; weekdays: number[] } }): { id: string };
  remove(id: string): boolean;
  update(id: string, patch: { botId?: string; name?: string; prompt?: string }): unknown;
}

export interface TodosHostDeps {
  store: TodoStore;
  bots(): readonly TodoBot[];
  routines(): TodoRoutines | null;
  teamCloud: boolean;
  /** Whether a bot may hand work to another bot (department walls). Absent: every bot may. */
  reachable?: (fromBotId: string, toBotId: string) => boolean;
  /** The audience of a conversation (audience.ts). Absent: everything is the team's. */
  audienceOf?: (threadId: string) => Audience;
  /** What the person a todo works for may do with a bot now. A todo with no person counts as nobody's. */
  levelFor(person: TodoPerson | undefined, botId: string): BotAccessLevel;
}

export interface TodoAddResult {
  todos: TodoRecord[];
  existing: TodoRecord[];
  refused: string[];
}

export interface BotCaller {
  botId: string;
  threadId: string;
}

function clean(text: unknown, limit: number, what: string): string {
  if (typeof text !== "string") throw new TodoError(400, `Write ${what} as text.`);
  const flat = text.replace(/\r\n?/g, "\n").trim();
  if (flat.length > limit) throw new TodoError(400, `Keep ${what} under ${limit} characters.`);
  return flat;
}

function cleanRepeat(repeat: unknown): TodoRepeat {
  const value = repeat as Partial<TodoRepeat> | null;
  if (!value || typeof value.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) throw new TodoError(400, "Give the time of day as hours and minutes, like 09:00.");
  const weekdays = Array.isArray(value.weekdays) ? [...new Set(value.weekdays.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6))].sort() : [];
  return { time: value.time, weekdays };
}

function cleanStart(start: unknown): TodoStart {
  const value = start as { kind?: unknown; todoId?: unknown; at?: unknown } | null;
  if (value?.kind === "free") return { kind: "free" };
  if (value?.kind === "at" && typeof value.at === "number" && Number.isFinite(value.at)) return { kind: "at", at: value.at };
  if (value?.kind === "after" && typeof value.todoId === "string" && value.todoId) return { kind: "after", todoId: value.todoId };
  throw new TodoError(400, "Pick when the todo may start.");
}

function cleanSource(source: unknown): TodoSource | undefined {
  if (source === undefined) return undefined;
  const value = source as Partial<TodoSource> | null;
  if (!value || typeof value.threadId !== "string" || !value.threadId) throw new TodoError(400, "The message this todo comes from is missing.");
  const quote = typeof value.quote === "string" ? value.quote.replace(/\s+/g, " ").trim().slice(0, TODO_QUOTE_CHARS) : undefined;
  return {
    threadId: value.threadId,
    ...(typeof value.messageId === "string" ? { messageId: value.messageId } : {}),
    ...(typeof value.botId === "string" ? { botId: value.botId } : {}),
    ...(typeof value.groupId === "string" ? { groupId: value.groupId } : {}),
    ...(quote ? { quote } : {}),
  };
}

function routinePrompt(todo: Pick<Todo, "title" | "note">): string {
  return todo.note ? `${todo.title}\n\n${todo.note}` : todo.title;
}

/** The rules every todo change goes through, whoever asks: a person, the runner or a bot. */
export function createTodosHost(deps: TodosHostDeps) {
  const { store } = deps;
  const botById = (id: string) => deps.bots().find((bot) => bot.id === id);
  const now = () => store.now();
  const audienceOfThread = (threadId: string): Audience => deps.audienceOf?.(threadId) ?? TEAM_AUDIENCE;
  const audienceOfTodo = (todo: Pick<TodoRecord, "audience" | "source">): Audience => todoAudienceFrom(todo, audienceOfThread);

  function requireBot(botId: string): TodoBot {
    const bot = botById(botId);
    if (!bot) throw new TodoError(400, "That bot is not on your team.");
    return bot;
  }

  function resolveBotRef(ref: string): TodoBot {
    const text = ref.trim();
    const found = botById(text) ?? deps.bots().find((bot) => namesTeammate(bot, text));
    if (!found) throw new TodoError(400, `No bot on the team matches "${text.slice(0, 60)}".`);
    return found;
  }

  function makeRoutine(todo: TodoRecord, botId: string): string {
    const routines = deps.routines();
    if (!routines) throw new TodoError(409, "Repeating todos are not available on this server.");
    // Security invariant: a routine of a todo is the place's, so it may not carry a todo that is not the team's.
    if (audienceOfTodo(todo) !== TEAM_AUDIENCE) throw new TodoError(409, "A repeating todo can come only from a shared place, not from a private chat or a room.");
    try {
      return routines.create({ name: todo.title, prompt: routinePrompt(todo), botId, schedule: { type: "daily", time: todo.repeat!.time, weekdays: todo.repeat!.weekdays } }).id;
    } catch (error) {
      if (error instanceof TodoError) throw error;
      throw new TodoError(400, "That repeat did not work. Check the time and the days.");
    }
  }

  function dropRoutine(routineId: string | undefined): void {
    if (!routineId) return;
    try {
      deps.routines()?.remove(routineId);
    } catch (error) {
      if (error instanceof TodoError) throw error;
    }
  }

  function picker(): string | null {
    return effectivePicker(store.chosenPicker(), deps.bots());
  }

  /** Security invariant: a person's todo goes only to a bot that person may chat with, whoever hands it on (the picker,
   * another bot, or someone else on the Board). Otherwise their words would reach a bot they may not give work to. */
  function personMayGive(todo: Pick<TodoRecord, "madeBy" | "person">, botId: string): boolean {
    // A todo a bot made works for a person only when one was recorded (a personal Seira's owner). Then the final bot
    // must be one that person may chat with, at every step: add, hand over, Board change, picker and start.
    return (todo.madeBy.kind !== "person" && !todo.person?.viewer?.email) || atLeast(deps.levelFor(todo.person, botId), "chat");
  }

  function depthFor(threadId: string): number {
    const parent = store.live().find((todo) => todo.threadId === threadId);
    return parent ? parent.depth + 1 : 0;
  }

  /** Adds todos in one step. A person's drafts either all go in or none; a bot's may be refused one by one.
   * `readable`: the todos the calling turn may read. A bot's draft matches only those. */
  function add(drafts: readonly TodoDraft[], maker: TodoMaker, options: { depth?: number; person?: TodoPerson; readable?: (todo: TodoRecord) => boolean } = {}): TodoAddResult {
    if (!Array.isArray(drafts) || drafts.length < 1 || drafts.length > TODO_BATCH_MAX) throw new TodoError(400, `Add between 1 and ${TODO_BATCH_MAX} todos at a time.`);
    const at = now();
    const result: TodoAddResult = { todos: [], existing: [], refused: [] };
    const created: TodoRecord[] = [];
    const slots: Array<TodoRecord | undefined> = [];
    const everything = store.everything();
    const live = store.live();
    const matchable = options.readable ? live.filter(options.readable) : live;
    const madeToday = maker.kind === "bot" ? everything.filter((todo) => todo.madeBy.kind === "bot" && todo.madeBy.botId === maker.botId && at - todo.createdAt < DAY_MS).length : 0;
    const depth = options.depth ?? 0;
    let starts = 0;
    const prepared = drafts.map((draft, index) => {
      const title = clean(draft.title, TODO_TITLE_CHARS, "the title");
      if (!title) throw new TodoError(400, "Give the todo a title.");
      const note = draft.note === undefined || draft.note === "" ? undefined : clean(draft.note, TODO_NOTE_CHARS, "the note");
      const botId = draft.botId === undefined ? undefined : requireBot(draft.botId).id;
      if (botId && !personMayGive({ madeBy: maker, ...(options.person ? { person: options.person } : {}) }, botId)) throw new TodoError(403, "You cannot give work to this bot.");
      if (draft.afterIndex !== undefined && (!Number.isInteger(draft.afterIndex) || draft.afterIndex < 0 || draft.afterIndex >= index)) throw new TodoError(400, "A todo can wait only for one that comes before it.");
      const start = draft.start === undefined ? undefined : cleanStart(draft.start);
      const repeat = draft.repeat === undefined ? undefined : cleanRepeat(draft.repeat);
      return { title, note, botId, start, repeat, afterIndex: draft.afterIndex, source: cleanSource(draft.source) };
    });
    if (maker.kind === "bot" && depth >= TODO_MAX_DEPTH) {
      return { ...result, refused: ["This work is already several todos deep. Tell the person what is missing instead of adding more todos."] };
    }
    prepared.forEach((item) => {
      const audience = item.source ? audienceOfThread(item.source.threadId) : TEAM_AUDIENCE;
      if (maker.kind === "bot") {
        // Security invariant: a todo of another audience, or one the calling turn may not read, is never matched, so
        // the answer cannot show it and a new todo cannot wait for it.
        const same = [...matchable, ...created].find((todo) => (todo.status === "open" || todo.status === "queued") && todo.botId === item.botId && audienceOfTodo(todo) === audience && sameTitle(todo.title, item.title));
        if (same) {
          result.existing.push(same);
          slots.push(same);
          return;
        }
        if (madeToday + starts >= TODO_BOT_DAILY_MAX) {
          result.refused.push(`You already added ${TODO_BOT_DAILY_MAX} todos today, so "${item.title.slice(0, 60)}" was not added.`);
          slots.push(undefined);
          return;
        }
        starts += 1;
      }
      const waitFor = item.afterIndex === undefined ? undefined : slots[item.afterIndex];
      const start: TodoStart = waitFor ? { kind: "after", todoId: waitFor.id } : item.start ?? { kind: "free" };
      const todo: TodoRecord = {
        id: store.newId(), title: item.title, ...(item.note ? { note: item.note } : {}), ...(item.botId ? { botId: item.botId } : {}),
        status: item.botId ? "queued" : "open", start, rank: store.endRank(item.botId) + created.filter((one) => one.botId === item.botId).length,
        madeBy: maker, audience, ...(item.source ? { source: item.source } : {}), ...(item.repeat ? { repeat: item.repeat } : {}),
        ...(options.person ? { person: structuredClone(options.person) } : {}),
        attempts: 0, depth, createdAt: at, updatedAt: at,
      };
      if (todo.repeat && todo.botId) todo.routineId = makeRoutine(todo, todo.botId);
      created.push(todo);
      slots.push(todo);
    });
    for (const todo of created) store.insert(todo);
    result.todos = created;
    return result;
  }

  function inQueue(todo: TodoRecord): boolean {
    return todo.status === "queued" && todo.botId !== undefined;
  }

  function giveTo(todo: TodoRecord, botId: string | null, by?: { botId: string; reason: string }): void {
    if (botId === null) {
      dropRoutine(todo.routineId);
      delete todo.routineId;
      delete todo.botId;
      delete todo.pickedBy;
      delete todo.offeredIn;
      delete todo.offeredAt;
      todo.status = "open";
      return;
    }
    const previous = todo.botId;
    todo.botId = botId;
    todo.status = "queued";
    delete todo.question;
    delete todo.stuck;
    delete todo.offeredIn;
    delete todo.offeredAt;
    if (by) todo.pickedBy = by;
    else delete todo.pickedBy;
    if (previous !== botId) todo.rank = store.endRank(botId);
    if (todo.routineId && previous !== botId) {
      try {
        deps.routines()?.update(todo.routineId, { botId });
      } catch {
        dropRoutine(todo.routineId);
        delete todo.routineId;
      }
    }
    if (todo.repeat && !todo.routineId) todo.routineId = makeRoutine(todo, botId);
  }

  function patch(id: string, change: TodoPatch, by: TodoMaker): TodoRecord {
    const current = store.get(id);
    if (!current) throw new TodoError(404, "That todo is gone.");
    if (change.botId !== undefined && change.botId !== null) requireBot(change.botId);
    if (change.title !== undefined && !clean(change.title, TODO_TITLE_CHARS, "the title")) throw new TodoError(400, "Give the todo a title.");
    const note = change.note === undefined || change.note === null ? change.note : clean(change.note, TODO_NOTE_CHARS, "the note");
    const start = change.start === undefined ? undefined : cleanStart(change.start);
    if (change.status !== undefined && change.status !== "queued" && change.status !== "done") throw new TodoError(400, "A todo can move only to the queue or to Done.");
    const changesBot = change.botId !== undefined && change.botId !== current.botId;
    if (changesBot && (current.status === "working" || current.status === "done")) throw new TodoError(409, "A todo that is being worked on or finished stays with its bot.");
    if (typeof change.botId === "string" && (changesBot || current.status === "needs-you") && !personMayGive(current, change.botId)) {
      throw new TodoError(403, "The person who wrote this todo cannot give work to this bot.");
    }
    if (change.status === "queued" && current.status === "working") throw new TodoError(409, "This todo is being worked on right now.");
    const updated = store.update(id, (todo) => {
      if (change.title !== undefined) todo.title = change.title.trim();
      if (note !== undefined) {
        if (note) todo.note = note;
        else delete todo.note;
      }
      if (start) todo.start = start;
      if (change.botId !== undefined && (changesBot || (change.botId !== null && todo.status === "needs-you"))) giveTo(todo, change.botId);
      if (change.status === "queued" && todo.status !== "queued") {
        if (!todo.botId) throw new TodoError(409, "Give the todo to a bot first.");
        todo.status = "queued";
        todo.attempts = 0;
        todo.rank = store.endRank(todo.botId);
        for (const key of ["question", "stuck", "result", "finishedAt", "closedBy", "threadId", "startedAt"] as const) delete todo[key];
      }
      if (change.status === "done" && todo.status !== "done") finish(todo, { by });
      if (change.beforeId !== undefined) {
        if (!inQueue(todo)) throw new TodoError(409, "Only a todo in the queue can move up or down.");
        if (change.beforeId === null) todo.rank = store.endRank(todo.botId);
        else {
          const rank = store.rankBefore(todo.botId!, change.beforeId, todo.id);
          if (rank === undefined) throw new TodoError(400, "That todo is not in this bot's queue.");
          todo.rank = rank;
        }
      }
      if (change.title !== undefined || note !== undefined) syncRoutineText(todo);
    });
    if (!updated) throw new TodoError(404, "That todo is gone.");
    return updated;
  }

  function syncRoutineText(todo: TodoRecord): void {
    if (!todo.routineId) return;
    try {
      deps.routines()?.update(todo.routineId, { name: todo.title, prompt: routinePrompt(todo) });
    } catch {
      // The routine is already gone; the todo keeps its text.
    }
  }

  function finish(todo: TodoRecord, how: { by?: TodoMaker; result?: string }): void {
    todo.status = "done";
    todo.finishedAt = now();
    delete todo.question;
    delete todo.stuck;
    if (how.by) todo.closedBy = how.by;
    if (how.result !== undefined) todo.result = how.result;
  }

  function markDone(id: string, by: TodoMaker, result?: string): TodoRecord {
    const updated = store.update(id, (todo) => {
      if (todo.status === "done") return false;
      finish(todo, { by, ...(result === undefined ? {} : { result }) });
    });
    if (!updated) throw new TodoError(404, "That todo is gone.");
    return updated;
  }

  function remove(id: string): void {
    const current = store.get(id);
    if (!current) throw new TodoError(404, "That todo is gone.");
    dropRoutine(current.routineId);
    store.remove(id);
  }

  function restore(id: string): TodoRecord {
    const back = store.restore(id);
    if (!back) throw new TodoError(404, "That todo can no longer be brought back.");
    if (!back.routineId) return back;
    const botId = back.botId;
    const remade = botId && botById(botId) ? store.update(id, (todo) => { todo.routineId = makeRoutine(todo, botId); }) : undefined;
    return remade ?? back;
  }

  function setPicker(botId: string | null): string | null {
    if (botId !== null) requireBot(botId);
    store.setPicker(botId);
    return picker();
  }

  function botMayChange(todo: TodoRecord, bot: TodoBot): boolean {
    const maker = todo.madeBy.kind === "bot" ? todo.madeBy.botId : undefined;
    if (todo.pickedBy?.botId === bot.id) return true;
    if (todo.status === "open" && picker() === bot.id) return true;
    return botMayClose({ botId: todo.botId ?? "", ...(maker ? { fromBotId: maker } : {}) }, bot, todo.botId ? botById(todo.botId) : undefined, deps.teamCloud);
  }

  function callerBot(caller: BotCaller): TodoBot {
    const bot = botById(caller.botId);
    if (!bot) throw new TodoError(404, "You are not on this team any more.");
    return bot;
  }

  function parseWhen(when: unknown): { start?: TodoStart; afterIndex?: number } {
    if (when === undefined || when === "free") return {};
    if (typeof when === "string") {
      const at = Date.parse(when);
      if (!Number.isFinite(at)) throw new TodoError(400, "Write the start time as a date and time, like 2026-12-01T09:00.");
      return { start: { kind: "at", at } };
    }
    const index = (when as { afterIndex?: unknown } | null)?.afterIndex;
    if (typeof index === "number") return { afterIndex: index };
    throw new TodoError(400, "Use \"free\", a date and time, or afterIndex for when to start.");
  }

  /** `person`: whom the conversation the bot is in works for; the todo's own conversation opens as them.
   * `readable`: the todos the calling turn may read, the same rule as botList. */
  function botAdd(caller: BotCaller, raw: unknown, person?: TodoPerson, readable: (todo: TodoRecord) => boolean = () => true): TodoAddResult {
    const bot = callerBot(caller);
    const list = Array.isArray(raw) ? raw : [];
    if (list.some((item: Record<string, unknown>) => item?.repeat)) throw new TodoError(403, "You cannot add a repeating todo. Ask for a repeating job with the routine request tool, so the person can confirm it.");
    const drafts = list.map((item: Record<string, unknown>): TodoDraft => {
      const ref = typeof item?.assigneeBotId === "string" && item.assigneeBotId.trim() ? resolveBotRef(item.assigneeBotId) : undefined;
      if (ref && ref.id !== bot.id && deps.reachable && !deps.reachable(bot.id, ref.id)) throw new TodoError(403, `${ref.name} is in a place you cannot hand work to. Tell the person instead.`);
      return {
        title: item?.title as string,
        ...(typeof item?.note === "string" ? { note: item.note } : {}),
        ...(ref ? { botId: ref.id } : {}),
        ...parseWhen(typeof item?.afterIndex === "number" ? { afterIndex: item.afterIndex } : item?.when),
        source: { threadId: caller.threadId, botId: caller.botId },
      };
    });
    return add(drafts, { kind: "bot", botId: caller.botId }, { depth: depthFor(caller.threadId), ...(person ? { person } : {}), readable });
  }

  function botList(filter: { status?: unknown; assigneeBotId?: unknown }, readable: (todo: TodoRecord) => boolean): TodoRecord[] {
    const status = typeof filter.status === "string" ? filter.status : undefined;
    const bot = typeof filter.assigneeBotId === "string" && filter.assigneeBotId.trim() ? resolveBotRef(filter.assigneeBotId) : undefined;
    return store.live().filter((todo) => (!status || todo.status === status) && (!bot || todo.botId === bot.id) && readable(todo)).sort((a, b) => a.rank - b.rank || a.createdAt - b.createdAt);
  }

  function botAssign(caller: BotCaller, args: { todoId?: unknown; assigneeBotId?: unknown; reason?: unknown }, readable: (todo: TodoRecord) => boolean = () => true): TodoRecord {
    const bot = callerBot(caller);
    const todo = typeof args.todoId === "string" ? store.get(args.todoId) : undefined;
    if (!todo || !readable(todo)) throw new TodoError(404, "No todo has that id.");
    if (todo.repeat || todo.routineId) throw new TodoError(403, "A repeating todo can be given to a bot only by the person.");
    if (typeof args.assigneeBotId !== "string") throw new TodoError(400, "Say which bot gets the todo.");
    const target = resolveBotRef(args.assigneeBotId);
    const reason = typeof args.reason === "string" ? args.reason.replace(/\s+/g, " ").trim().slice(0, REASON_CHARS) : "";
    if (!reason) throw new TodoError(400, "Give a one-line reason.");
    if (!botMayChange(todo, bot)) throw new TodoError(403, "You may hand over only todos that are yours, that you made, or that you hand out as picker.");
    if (todo.status === "working" || todo.status === "done") throw new TodoError(409, "That todo is already being worked on or finished.");
    if (target.id !== bot.id && deps.reachable && !deps.reachable(bot.id, target.id)) throw new TodoError(403, `${target.name} is in a place you cannot hand work to.`);
    if (!personMayGive(todo, target.id)) throw new TodoError(403, `The person who wrote this todo cannot give work to ${target.name}. Leave it for them.`);
    const updated = store.update(todo.id, (one) => giveTo(one, target.id, { botId: bot.id, reason }));
    return updated!;
  }

  function botUpdate(caller: BotCaller, args: { todoId?: unknown; status?: unknown; title?: unknown; note?: unknown; result?: unknown }, readable: (todo: TodoRecord) => boolean = () => true): TodoRecord {
    const bot = callerBot(caller);
    const todo = typeof args.todoId === "string" ? store.get(args.todoId) : undefined;
    if (!todo || !readable(todo)) throw new TodoError(404, "No todo has that id.");
    if (todo.repeat || todo.routineId) throw new TodoError(403, "A repeating todo can be changed only by the person.");
    if (!botMayChange(todo, bot)) throw new TodoError(403, "You may change only todos that are yours, that you made, or that you hand out as picker.");
    const by: TodoMaker = { kind: "bot", botId: bot.id };
    if (args.status !== undefined && args.status !== "done" && args.status !== "queued") throw new TodoError(400, "Status can be done or queued.");
    const result = typeof args.result === "string" ? args.result.trim().slice(0, 2000) : undefined;
    let current: TodoRecord = todo;
    if (typeof args.title === "string" || typeof args.note === "string" || args.status === "queued") {
      current = patch(todo.id, {
        ...(typeof args.title === "string" ? { title: args.title } : {}),
        ...(typeof args.note === "string" ? { note: args.note } : {}),
        ...(args.status === "queued" ? { status: "queued" as const } : {}),
      }, by);
    }
    if (args.status === "done") return markDone(todo.id, by, result);
    if (result !== undefined && todo.botId === bot.id) return store.update(todo.id, (one) => { one.result = result; }) ?? current;
    return current;
  }

  return { add, patch, markDone, remove, restore, setPicker, picker, botAdd, botList, botAssign, botUpdate, depthFor, botMayChange, resolveBotRef, personMayGive, audienceOf: audienceOfTodo };
}

export type TodosHost = ReturnType<typeof createTodosHost>;

/** What a bot sees of a todo in a tool answer. */
export function todoLine(todo: Pick<Todo, "id" | "title" | "status" | "botId" | "start">, botName: (id: string) => string | undefined): string {
  const who = todo.botId ? `@${botName(todo.botId) ?? todo.botId}` : "no bot yet";
  return `- ${todo.title} (${todo.status}, ${who}) [todo id: ${todo.id}]`;
}

const TITLE_FOR_THREAD = 80;

type TurnOptions = {
  threadId: string;
  unattended: true;
  origin: WorkOrigin;
  trigger: UsageTrigger;
  /** A person's todo: who wrote it, by name only, so the turn acts for nobody (server/host/acting-person.ts). */
  sender?: { name: string };
  peerAsk?: { botId: string; name: string; unattended: true };
  userMessage?: unknown;
  onDispatchError?: (message: string) => void;
};

export interface TodoLauncherDeps {
  store: {
    appendMessage(threadId: string, message: Record<string, unknown>): { id: string };
  };
  /** Makes the todo's conversation, opened as the person the todo works for (todo.person); null when its bot is gone. */
  openTask(todo: TodoRecord, title: string): { threadId: string } | null;
  startTurn(botId: string, text: string, options: TurnOptions): Promise<unknown>;
  /** The server would start a turn for this bot in this conversation now. */
  admits(botId: string, threadId: string): boolean;
  /** Holds the first line behind the bot's other work: what a person's own message gets when the bot is busy. */
  queue(botId: string, threadId: string, text: string, options: Omit<TurnOptions, "threadId" | "userMessage" | "onDispatchError"> & { prompt: string; rowId: string }): void;
  botName(botId: string): string | undefined;
  /** The audience the work of a todo may be seen in. */
  audienceOf(todo: TodoRecord): Audience;
  /** Whether a conversation can be made private to this audience; the team's always can. */
  adoptable(audience: Audience): boolean;
  /** Makes the conversation private to the audience, before its first line. */
  adopt(threadId: string, audience: Audience): void;
}

/** Makes the conversation for a todo and starts its first turn.
 * Security invariant: the first line is never the person's own request. A todo a bot made runs with that bot's
 * authority as a peer ask; a todo a person made runs as unattended work, like a routine the person set up. Either way
 * its conversation opens as the person it works for, so a guest's todo stays confined as the guest's own chat is. */
export function createTodoLauncher(deps: TodoLauncherDeps) {
  return async function launch(todo: TodoRecord, launch: TodoLaunch): Promise<void> {
    const botId = todo.botId;
    if (!botId) throw new Error("This todo has no bot.");
    const audience = deps.audienceOf(todo);
    // Security invariant: the work conversation keeps the audience of its todo, or the work does not start.
    if (!deps.adoptable(audience)) throw new Error("This todo comes from a place its work cannot be kept private to.");
    const task = deps.openTask(todo, launch.line.split("\n")[0]!.slice(0, TITLE_FOR_THREAD));
    if (!task) throw new Error("The bot for this todo is gone.");
    deps.adopt(task.threadId, audience);
    launch.onThread(task.threadId);
    const maker = todo.madeBy.kind === "bot" ? todo.madeBy.botId : undefined;
    const peerAsk = maker ? { botId: maker, name: deps.botName(maker) ?? "A teammate", unattended: true as const } : undefined;
    const writer = todo.madeBy.kind === "person" ? todo.madeBy.name.trim() : "";
    const email = todo.person?.viewer?.email;
    const base = {
      unattended: true as const,
      origin: OUTSIDE,
      trigger: (maker ? { kind: "bot", botId: maker } : { kind: "routine", label: "Todo", ...(email ? { email } : {}) }) as UsageTrigger,
      ...(peerAsk ? { peerAsk } : {}),
      ...(writer ? { sender: { name: writer } } : {}),
    };
    const admitted = deps.admits(botId, task.threadId);
    if (!admitted && !launch.force) throw new Error("The bot has no room for this work right now.");
    const line = deps.store.appendMessage(task.threadId, {
      role: "user", kind: "text", text: launch.line, fromTodo: todo.id, automated: true, ...(peerAsk ? { peerAsk } : {}), ...(base.sender ? { sender: base.sender } : {}),
    });
    if (!admitted) {
      deps.queue(botId, task.threadId, launch.line, { ...base, prompt: launch.prompt, rowId: line.id });
      return;
    }
    await deps.startTurn(botId, launch.prompt, { ...base, threadId: task.threadId, userMessage: line, onDispatchError: launch.onFailed });
  };
}
