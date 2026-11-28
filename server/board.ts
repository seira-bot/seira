import type { Audience } from "./audience.ts";
import type { BoardClosure } from "./board-closed.ts";
import type { Todo } from "../shared/todo.ts";
import { readyQueue, todoVisible } from "./todos.ts";
import { BOARD_DONE_MAX, BOARD_DONE_WINDOW_MS, BOARD_TITLE_CHARS, type BoardCard, type BoardColumn, type BoardView } from "../shared/board.ts";

interface HandoffRow {
  id: string;
  parentId?: string;
  threadId: string;
  groupId?: string;
  botId: string;
  text: string;
  createdAt: number;
  status: "source" | "queued" | "running" | "waiting" | "resume" | "completed" | "failed" | "cancelled";
  result: string;
  startedAt?: number;
  lastProgressAt?: number;
  mode: "work" | "consult" | "notify";
  statusOnly?: boolean;
  outcomeDetail?: string;
  question?: string;
  decide?: unknown;
}

interface ThreadRow {
  threadId: string;
  title: string;
  createdAt: number;
  updatedAt?: number;
  activity?: string;
  routineRunId?: string;
  archivedAt?: number;
  closedBy?: { at: number };
}

interface RunRow {
  id: string;
  routineId: string;
  routineName: string;
  botId: string;
  groupId?: string;
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "missed";
  threadId?: string;
  scheduledFor: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

export interface BoardSources {
  handoffs(from: number): readonly HandoffRow[];
  threads: ReadonlyArray<{ botId: string; task: ThreadRow }>;
  runs(from: number): readonly RunRow[];
  closed?: (cardId: string) => BoardClosure | undefined;
  /** The todos and the bot picker (null: nobody hands out open todos, so they wait for the person). */
  todos?: () => { todos: ReadonlyArray<Todo & { audience?: Audience }>; picker: string | null };
}

export interface BoardViewer {
  thread(threadId: string): boolean;
  bot(botId: string): boolean;
  audience(audience: Audience): boolean;
  routine(run: { botId?: unknown; groupId?: unknown; threadId?: unknown }): boolean;
  /** Whether the person a todo works for lets this viewer read it (on a personal Cloud a guest reads only their own).
   * Absent: yes. */
  todo?(todoId: string): boolean;
}

const BRIEF_CHARS = 2000;
const TEXT_CHARS = 500;
const COLUMNS: readonly BoardColumn[] = ["todo", "working", "needs-you", "done"];

function plain(text: string, limit: number): string {
  const line = text.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

function plainTitle(text: string): string {
  const first = text.split("\n").map((line) => line.replace(/^[\s#>]+/, "").trim()).find((line) => line !== "") ?? "";
  return plain(first, BOARD_TITLE_CHARS);
}

function handoffCards(rows: readonly HandoffRow[], viewer: BoardViewer): BoardCard[] {
  const botOf = new Map(rows.map((row) => [row.id, row.botId]));
  const cards: BoardCard[] = [];
  for (const row of rows) {
    if (!row.parentId || row.status === "source" || row.status === "cancelled" || row.mode === "notify" || row.statusOnly) continue;
    if (!viewer.thread(row.threadId)) continue;
    const fromBot = botOf.get(row.parentId);
    const base = {
      id: `handoff:${row.id}`, kind: "handoff" as const, title: plainTitle(row.text), botId: row.botId, threadId: row.threadId,
      ...(row.groupId ? { groupId: row.groupId } : {}),
      ...(fromBot && viewer.bot(fromBot) ? { fromBotId: fromBot } : {}),
      brief: row.text.length > BRIEF_CHARS ? `${row.text.slice(0, BRIEF_CHARS - 1)}…` : row.text,
      createdAt: row.createdAt, updatedAt: row.lastProgressAt ?? row.startedAt ?? row.createdAt,
    };
    if (row.status === "queued") cards.push({ ...base, column: "todo", state: "queued", group: "next" });
    else if (row.status === "running" || row.status === "resume") cards.push({ ...base, column: "working", state: "running" });
    else if (row.status === "waiting") {
      const asksPerson = Boolean(row.question) && !row.decide;
      cards.push(asksPerson
        ? { ...base, column: "needs-you", state: "needs-input", question: row.question! }
        : { ...base, column: "working", state: "waiting-teammate" });
    } else if (row.status === "failed") {
      const error = plain(row.outcomeDetail || row.result, TEXT_CHARS);
      cards.push({ ...base, column: "needs-you", state: "failed", ...(error ? { error } : {}) });
    } else if (row.status === "completed") cards.push({ ...base, column: "done", state: "completed", result: row.result });
  }
  return cards;
}

function threadCards(sources: BoardSources["threads"], taken: ReadonlySet<string>, viewer: BoardViewer): BoardCard[] {
  const cards: BoardCard[] = [];
  for (const { botId, task } of sources) {
    if (taken.has(task.threadId) || task.routineRunId || task.archivedAt !== undefined) continue;
    if (!viewer.thread(task.threadId)) continue;
    const updatedAt = task.updatedAt ?? task.createdAt;
    const base = { id: `thread:${task.threadId}`, kind: "thread" as const, title: plainTitle(task.title), botId, threadId: task.threadId, createdAt: task.createdAt };
    if (task.activity === "working") cards.push({ ...base, column: "working", state: "running", updatedAt });
    else if (task.activity === "waiting-on-you") cards.push({ ...base, column: "needs-you", state: "waiting-on-you", updatedAt });
    else if (task.closedBy) cards.push({ ...base, column: "done", state: "closed", updatedAt: task.closedBy.at });
  }
  return cards;
}

function runCards(runs: readonly RunRow[], viewer: BoardViewer): BoardCard[] {
  const cards: BoardCard[] = [];
  for (const run of runs) {
    if (run.status === "cancelled" || run.status === "missed") continue;
    if (!viewer.routine(run)) continue;
    const base = {
      id: `routine:${run.id}`, kind: "routine" as const, title: plainTitle(run.routineName), botId: run.botId, routineId: run.routineId,
      ...(run.threadId ? { threadId: run.threadId } : {}), ...(run.groupId ? { groupId: run.groupId } : {}),
      createdAt: run.scheduledFor, updatedAt: run.finishedAt ?? run.startedAt ?? run.scheduledFor,
    };
    if (run.status === "queued") cards.push({ ...base, column: "todo", state: "queued", group: "next" });
    else if (run.status === "running" || run.status === "waiting") cards.push({ ...base, column: "working", state: "running" });
    else if (run.status === "failed") {
      const error = plain(run.error ?? "", TEXT_CHARS);
      cards.push({ ...base, column: "needs-you", state: "failed", ...(error ? { error } : {}) });
    } else cards.push({ ...base, column: "done", state: "completed" });
  }
  return cards;
}

function todoCards(source: NonNullable<BoardSources["todos"]>, viewer: BoardViewer, now: number): BoardCard[] {
  const { picker, ...all } = source();
  const shown = (todo: Todo & { audience?: Audience }) => todoVisible(todo, viewer) && (!viewer.todo || viewer.todo(todo.id));
  const todos = all.todos.filter(shown);
  const ready = new Set<string>();
  const place = new Map<string, number>();
  for (const botId of new Set(todos.map((todo) => todo.botId).filter((id): id is string => Boolean(id)))) {
    // Readiness looks at every todo; a place in the queue counts only the todos the viewer sees.
    readyQueue(all.todos, botId, now).filter(shown).forEach((todo, index) => { ready.add(todo.id); place.set(todo.id, index + 1); });
  }
  const cards: BoardCard[] = [];
  for (const todo of todos) {
    const base = {
      id: `todo:${todo.id}`, kind: "todo" as const, todoId: todo.id, title: plainTitle(todo.title), botId: todo.botId ?? "",
      ...(todo.madeBy.kind === "bot" && viewer.bot(todo.madeBy.botId) ? { fromBotId: todo.madeBy.botId } : {}),
      ...(todo.threadId ? { threadId: todo.threadId } : {}), ...(todo.routineId ? { routineId: todo.routineId } : {}),
      createdAt: todo.createdAt, updatedAt: todo.updatedAt,
    };
    if (todo.status === "open") {
      cards.push(picker
        ? { ...base, column: "todo", state: "open", group: "open" }
        : { ...base, column: "needs-you", state: "unassigned", group: "open" });
    } else if (todo.status === "queued") {
      if (ready.has(todo.id)) cards.push({ ...base, column: "todo", state: "queued", group: "next", place: place.get(todo.id)! });
      else cards.push({ ...base, column: "todo", state: "scheduled", group: "scheduled" });
    } else if (todo.status === "working") cards.push({ ...base, column: "working", state: "running" });
    else if (todo.status === "needs-you") {
      if (todo.stuck === "unassigned") cards.push({ ...base, column: "needs-you", state: "unassigned", group: "open" });
      else if (todo.question) cards.push({ ...base, column: "needs-you", state: "needs-input", question: todo.question });
      else cards.push({ ...base, column: "needs-you", state: "waiting-on-you" });
    } else {
      const result = todo.result ? { result: todo.result } : {};
      cards.push(todo.closedBy
        ? { ...base, column: "done", state: "closed", closedBy: todo.closedBy, ...result, updatedAt: todo.finishedAt ?? todo.updatedAt }
        : { ...base, column: "done", state: "completed", ...result, updatedAt: todo.finishedAt ?? todo.updatedAt });
    }
  }
  return cards;
}

function withClosure(card: BoardCard, closed: BoardSources["closed"]): BoardCard {
  if (card.column !== "needs-you") return card;
  const closure = closed?.(card.id);
  if (!closure || closure.at < card.updatedAt) return card;
  const moved: BoardCard = { ...card, column: "done", state: "closed", updatedAt: closure.at, closedBy: closure.by };
  delete moved.question;
  if (closure.reason) moved.closedReason = closure.reason;
  return moved;
}

/** A bot may move a card to Done when the work is its own or it handed the work over. A Chief of Staff may also close a
 * teammate's card: any card off a Team Cloud, and on one only a card of a bot in its own non-empty section. */
export function botMayClose(
  card: Pick<BoardCard, "botId" | "fromBotId">,
  bot: { id: string; chiefOfStaff?: boolean; section?: string },
  cardBot: { section?: string } | undefined,
  teamCloud: boolean,
): boolean {
  if (card.botId === bot.id || card.fromBotId === bot.id) return true;
  if (bot.chiefOfStaff !== true) return false;
  if (!teamCloud) return true;
  const section = bot.section?.trim();
  return Boolean(section) && cardBot?.section?.trim() === section;
}

export function boardView(sources: BoardSources, viewer: BoardViewer, now = Date.now()): BoardView {
  const runs = sources.runs(now - BOARD_DONE_WINDOW_MS);
  const handoffs = handoffCards(sources.handoffs(now - BOARD_DONE_WINDOW_MS), viewer);
  const taken = new Set<string>();
  for (const card of handoffs) if (card.threadId) taken.add(card.threadId);
  for (const run of runs) if (run.threadId) taken.add(run.threadId);
  const todos = sources.todos ? todoCards(sources.todos, viewer, now) : [];
  for (const card of todos) if (card.threadId) taken.add(card.threadId);
  const cutoff = now - BOARD_DONE_WINDOW_MS;
  const recent = [...handoffs, ...threadCards(sources.threads, taken, viewer), ...runCards(runs, viewer)]
    .map((card) => withClosure(card, sources.closed))
    .concat(todos)
    .filter((card) => (card.column !== "done" && card.state !== "failed") || card.updatedAt >= cutoff);
  const cards: BoardCard[] = [];
  const seen = new Set<string>();
  for (const column of COLUMNS) {
    const inColumn = recent
      .filter((card) => card.column === column)
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
    for (const card of column === "done" ? inColumn.slice(0, BOARD_DONE_MAX) : inColumn) {
      if (seen.has(card.id)) continue;
      seen.add(card.id);
      cards.push(card);
    }
  }
  return { cards };
}
