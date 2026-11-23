import { describe, expect, it } from "vitest";

import { INBOX_SORT_INSTRUCTIONS, INBOX_SORT_OPTIONS, INBOX_SORT_STATE_KEYS, inboxSortRequest, NOT_DECISION_TEXT_MAX, NOT_DECISIONS_MAX } from "./inbox-sort.ts";
import { DECIDER_JOBS } from "./types.ts";
import { relaySeam } from "./relay.ts";

describe("the Inbox sort request", () => {
  it("sends the fixed question and the message as cleaned data", () => {
    const { state, question } = inboxSortRequest({ from: "Eli", message: "Approve the launch?" });
    expect(state).toEqual({ from: "Eli", message: "Approve the launch?" });
    expect(question).toEqual({ instructions: INBOX_SORT_INSTRUCTIONS, options: INBOX_SORT_OPTIONS });
    expect(Object.keys(question.options)).toEqual(["decision", "news"]);
    expect(Object.keys(state).every((key) => (INBOX_SORT_STATE_KEYS as readonly string[]).includes(key))).toBe(true);
  });

  it("omits not_decisions when there is none, or when every one is empty", () => {
    expect(inboxSortRequest({ from: "Eli", message: "Hi", notDecisions: [] }).state).not.toHaveProperty("not_decisions");
    expect(inboxSortRequest({ from: "Eli", message: "Hi", notDecisions: ["", "   "] }).state).not.toHaveProperty("not_decisions");
  });

  it("cleans each text to its limit and keeps at most 10 counter-examples", () => {
    const many = Array.from({ length: 15 }, (_, index) => `Not a decision ${index}`);
    const { state } = inboxSortRequest({ from: "E".repeat(500), message: "m".repeat(5_000), notDecisions: [...many, "x".repeat(900)] });
    expect(Array.from(state.from).length).toBeLessThanOrEqual(160);
    expect(Array.from(state.message).length).toBeLessThanOrEqual(1_200);
    expect(state.not_decisions).toHaveLength(NOT_DECISIONS_MAX);
    expect(state.not_decisions).toEqual(many.slice(0, NOT_DECISIONS_MAX));
    const long = inboxSortRequest({ from: "E", message: "m", notDecisions: ["x".repeat(900)] }).state.not_decisions!;
    expect(Array.from(long[0]!).length).toBeLessThanOrEqual(NOT_DECISION_TEXT_MAX);
  });

  it("is a decision job that the included relay does not take", () => {
    expect(DECIDER_JOBS).toContain("inboxSort");
    expect(relaySeam("inboxSort")).toBe(false);
  });
});
