import type { BoardClosure } from "./board-closed.ts";
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
}

export interface BoardViewer {
  thread(threadId: string): boolean;
  bot(botId: string): boolean;
  routine(run: { botId?: unknown; groupId?: unknown; threadId?: unknown }): boolean;
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
    if (row.status === "queued") cards.push({ ...base, column: "todo", state: "queued" });
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
    if (run.status === "queued") cards.push({ ...base, column: "todo", state: "queued" });
    else if (run.status === "running" || run.status === "waiting") cards.push({ ...base, column: "working", state: "running" });
    else if (run.status === "failed") {
      const error = plain(run.error ?? "", TEXT_CHARS);
      cards.push({ ...base, column: "needs-you", state: "failed", ...(error ? { error } : {}) });
    } else cards.push({ ...base, column: "done", state: "completed" });
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
  const cutoff = now - BOARD_DONE_WINDOW_MS;
  const recent = [...handoffs, ...threadCards(sources.threads, taken, viewer), ...runCards(runs, viewer)]
    .map((card) => withClosure(card, sources.closed))
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
