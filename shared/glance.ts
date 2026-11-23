/** What the page on screen tells the desktop app about its bots, for Glance: the visor at the top of the screen
 * (macOS, Windows, Linux X11) or the Glance tray icon (Linux Wayland). The page sends the whole feed on every change;
 * the desktop app keeps no copy of chats, only the latest feed. */

/** A bot Glance shows. A bot that is idle is left out of the feed. "done" is not sent: the desktop app sees a bot
 * leave "working" and shows it as done for a few seconds. */
export type GlanceBotState = "working" | "needs" | "question" | "failed";

export interface GlanceChoice {
  id: string;
  label: string;
}

/** An approval or a question the bot waits on, as its chat card shows it. */
export interface GlanceAsk {
  kind: "approval" | "question";
  /** The card's request id; an answer names it. */
  requestId: string;
  /** What the bot asks, in the app's language, for example "Felix wants to run a command". */
  title: string;
  /** A question's choices, at most GLANCE_LIMITS.choices. Empty for an approval and for a question that needs typing. */
  choices: GlanceChoice[];
  /** Security: what an approval covers (the command, file or site), whole, as the Inbox row shows it. Glance offers
   * Allow only next to this text, so it is empty, and only Deny and Open chat show, when the approval is not a plain
   * tool approval or its text is longer than GLANCE_LIMITS.detail. Empty for a question. */
  detail: string;
  /** An approval whose card offers Always allow. */
  canAlways: boolean;
}

export interface GlanceBot {
  botId: string;
  /** The conversation the state belongs to; Open chat goes there. */
  threadId: string;
  name: string;
  /** A same-origin path under /api/attachments/, or null for the mascot. */
  avatarUrl: string | null;
  /** The bot's colour as #rrggbb, or null. */
  color: string | null;
  state: GlanceBotState;
  /** What a working bot does, in plain words, for example "Searching the web". Never a raw command. Empty when the
   * state word says it all. */
  line: string;
  /** When the current turn started, in milliseconds since the epoch, or null. */
  startedAt: number | null;
  ask: GlanceAsk | null;
}

/** The visor's own words, in the app's language. `finished` and `failedLine` hold `{name}`. */
export interface GlanceLabels {
  glance: string;
  working: string;
  needsYou: string;
  question: string;
  failed: string;
  finished: string;
  failedLine: string;
  openChat: string;
  deny: string;
  allowOnce: string;
  alwaysAllow: string;
  couldNotSend: string;
  close: string;
}

export interface GlanceFeed {
  version: 1;
  /** The app's language tag, for durations. */
  lang: string;
  bots: GlanceBot[];
  labels: GlanceLabels;
}

/** What the person did in Glance. The page answers through the same path as the chat card and resolves true when the
 * answer was sent. */
export type GlanceAct =
  | { kind: "open"; botId: string; threadId: string }
  | { kind: "approval"; botId: string; threadId: string; requestId: string; choice: "deny" | "once" | "always" }
  | { kind: "answer"; botId: string; threadId: string; requestId: string; choiceId: string };

/** Security: main drops a feed that breaks these limits, so a page cannot grow the visor or main's memory. */
export const GLANCE_LIMITS = Object.freeze({
  bots: 12,
  name: 80,
  line: 160,
  title: 240,
  detail: 400,
  choices: 4,
  choiceLabel: 80,
  label: 120,
  id: 128,
});
