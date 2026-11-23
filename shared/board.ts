// The Board page's wire shape: every piece of work the person's bots have
// open or finished lately, one card each, in four fixed columns.

/** Bots move cards between columns; a person never drops a card into "needs-you". */
export type BoardColumn = "todo" | "working" | "needs-you" | "done";

/** handoff: one bot handed work to another. thread: a conversation a bot is working in.
 * routine: one run of an automation. */
export type BoardCardKind = "handoff" | "thread" | "routine";

/** queued: waits for its bot. running: its bot works on it. waiting-teammate: it waits on another bot.
 * needs-input: its bot asked the person a question. waiting-on-you: a conversation waits on the person.
 * failed: it ran into a problem. completed: it finished. closed: the bot closed the conversation, or a person or a bot
 * moved the card to Done. */
export type BoardCardState =
  | "queued" | "running" | "waiting-teammate" | "needs-input" | "waiting-on-you" | "failed" | "completed" | "closed";

export interface BoardCard {
  /** Stable across reads: `handoff:<assignment id>`, `thread:<thread id>` or `routine:<run id>`. */
  id: string;
  kind: BoardCardKind;
  column: BoardColumn;
  state: BoardCardState;
  /** Plain text, at most BOARD_TITLE_CHARS. Empty when the conversation has no title yet. */
  title: string;
  /** The bot that does the work. */
  botId: string;
  /** The conversation to open; absent for a routine run that never reached one. */
  threadId?: string;
  /** Set when the work happens in a group chat. */
  groupId?: string;
  /** The bot that handed this work over. */
  fromBotId?: string;
  routineId?: string;
  /** The bot's question, when the state is needs-input. */
  question?: string;
  /** The failure's own words, when the state is failed. */
  error?: string;
  /** What was asked for, for a handoff. */
  brief?: string;
  /** The bot's result, when the state is completed. */
  result?: string;
  /** Who moved the card to Done, when the state is closed that way. */
  closedBy?: { kind: "person"; name: string } | { kind: "bot"; botId: string };
  /** Why it was closed, at most BOARD_CLOSE_REASON_CHARS. */
  closedReason?: string;
  createdAt: number;
  /** Cards in a column are newest first by this time. */
  updatedAt: number;
}

export interface BoardView {
  cards: BoardCard[];
}

export const BOARD_TITLE_CHARS = 120;
export const BOARD_CLOSE_REASON_CHARS = 200;
/** Finished and failed work older than this leaves the Board. */
export const BOARD_DONE_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** The Done column keeps at most this many cards, newest first. */
export const BOARD_DONE_MAX = 100;
