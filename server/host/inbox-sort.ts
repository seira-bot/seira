// Sorts a bot's message to the person on the decision model: a decision they must make, or news. Fail-open: with the
// model off, without an account, or on any failure the answer is null and the message stays as it was.
import type { AppConfig } from "../config.ts";
import { deciderReady, type Decider } from "../decider/index.ts";
import { inboxSortRequest, INBOX_SORT_MIN_P, INBOX_SORT_TIMEOUT_MS } from "../decider/inbox-sort.ts";

export interface InboxSortDeps {
  decider: Pick<Decider, "choose">;
  config(): AppConfig;
}

export interface InboxSortMessage { from: string; text: string; notDecisions: readonly string[] }

export function createInboxSort(deps: InboxSortDeps) {
  return {
    /** Null when the model cannot say; never throws. */
    async sort(input: InboxSortMessage): Promise<"decision" | "news" | null> {
      try {
        if (!deciderReady(deps.config(), "inboxSort")) return null;
        const { state, question } = inboxSortRequest({ from: input.from, message: input.text, notDecisions: input.notDecisions });
        const decided = await deps.decider.choose("inboxSort", state, question, { timeoutMs: INBOX_SORT_TIMEOUT_MS });
        if (!decided.ok) return null;
        const { choice, probabilities } = decided.answers;
        return choice === "decision" && (probabilities.decision ?? 0) >= INBOX_SORT_MIN_P ? "decision" : "news";
      } catch {
        return null;
      }
    },
  };
}

export type InboxSort = ReturnType<typeof createInboxSort>;
