// Sorts one message a bot sent the person: does it ask them to decide, or only tell them something. Fixed instructions and
// options, so the request keeps one shape; the message reaches the model only as cleaned data in `state`.
import { clean } from "../records-block.ts";

export const INBOX_SORT_INSTRUCTIONS = "Does `message`, which a bot sent to the person, ask them to decide, approve, choose, or do something themselves? `not_decisions` lists messages the person said were not decisions.";
export const INBOX_SORT_OPTIONS = {
  decision: "It asks the person to decide, approve, choose, or take a step only they can take, now or soon.",
  news: "It reports progress, a result, or information, and needs nothing from them; or it is like a message in not_decisions.",
} as const;
export type InboxSortVerdict = keyof typeof INBOX_SORT_OPTIONS;
export const INBOX_SORT_STATE_KEYS = ["from", "message", "not_decisions"] as const;
export const INBOX_SORT_TIMEOUT_MS = 4_000;
export const NOT_DECISIONS_MAX = 10;
export const NOT_DECISION_TEXT_MAX = 300;
/** A `decision` verdict below this probability is kept as news. */
export const INBOX_SORT_MIN_P = 0.6;

export interface InboxSortInput {
  from: string;
  message: string;
  notDecisions?: readonly string[];
}

export function inboxSortRequest(input: InboxSortInput) {
  const notDecisions = (input.notDecisions ?? []).map((text) => clean(text, NOT_DECISION_TEXT_MAX)).filter(Boolean).slice(0, NOT_DECISIONS_MAX);
  return {
    state: {
      from: clean(input.from, 160),
      message: clean(input.message, 1_200),
      ...(notDecisions.length ? { not_decisions: notDecisions } : {}),
    },
    question: { instructions: INBOX_SORT_INSTRUCTIONS, options: { ...INBOX_SORT_OPTIONS } },
  };
}
