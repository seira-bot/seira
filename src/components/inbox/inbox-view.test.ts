import { describe, expect, it } from "vitest";

import { approvalRow, inboxView, messageRow, questionRow, reportRow, settledRow } from "@/testing/inbox-fixture";
import type { InboxRow } from "../../../shared/inbox";
import { askOf, choiceResponse, choicesOf, closeResponse, inboxItems, isDecision, isNews, listedRows, quickActions, rowsIn, subjectOf, tabCounts, waitingCount } from "./inbox-view";

describe("the inbox's lines", () => {
  it("lists what waits on the person and their news as one list, newest first, and leaves settled lines out", () => {
    expect(listedRows(inboxView()).map((row) => row.id)).toEqual([approvalRow.id, questionRow.id, messageRow.id, reportRow.id]);
    expect(listedRows(inboxView([reportRow, approvalRow])).map((row) => row.id)).toEqual([approvalRow.id, reportRow.id]);
    expect(listedRows(null)).toEqual([]);
  });

  it("still knows each line's place, for the chat's card and its counts", () => {
    const view = inboxView();
    expect(rowsIn(view, "needs-you").map((row) => row.id)).toEqual([approvalRow.id, questionRow.id]);
    expect(rowsIn(view, "info").map((row) => row.id)).toEqual([messageRow.id, reportRow.id]);
    expect(rowsIn(view, "done").map((row) => row.id)).toEqual([settledRow.id]);
    expect(tabCounts(view)).toEqual({ "needs-you": 2, info: 2, done: 1 });
    expect(tabCounts(null)).toEqual({ "needs-you": 0, info: 0, done: 0 });
  });

  it("answers only an ask that is still open: news and a settled ask offer no answer", () => {
    expect([approvalRow, questionRow, messageRow, reportRow, settledRow].map(askOf)).toEqual(["approval", "question", null, null, null]);
  });
});

describe("a row's actions", () => {
  it("offers an approval's own answer first, a question's reply and close, news its done, anything else its chat", () => {
    expect(quickActions(approvalRow)).toEqual(["allow", "deny", "reply"]);
    expect(quickActions(questionRow)).toEqual(["reply", "close"]);
    expect(quickActions(messageRow)).toEqual(["done", "open"]);
    expect(quickActions(reportRow)).toEqual(["done", "open"]);
    expect(quickActions(settledRow)).toEqual(["open"]);
  });

  it("names each line's subject plainly, or by the conversation a message came from", () => {
    expect([approvalRow, questionRow, reportRow].map(subjectOf)).toEqual(["Approval", "Question", "Routine report"]);
    expect(subjectOf(messageRow)).toBe("Message");
    expect(subjectOf({ ...messageRow, origin: { botId: "scout", threadId: "scout-main", title: "Launch" } })).toBe("Launch");
  });

  it("taps a question's choice as its answer, in the card's own format, and closes it without one", () => {
    expect(choicesOf(questionRow)).toEqual(["Home", "Pricing"]);
    expect(choiceResponse(questionRow, "Home")).toEqual({ behavior: "answer", message: "Home" });
    const asked = { ...questionRow, card: { ...questionRow.card!, questionRequest: { version: 1 as const, questions: [{ question: "Which page?", options: [{ label: "Home" }, { label: "Pricing" }] }] } } };
    expect(choicesOf(asked)).toEqual(["Home", "Pricing"]);
    expect(choiceResponse(asked, "Pricing").message).toContain("Pricing");
    expect(closeResponse(questionRow)).toMatchObject({ behavior: "answer", dismiss: true });
    expect(closeResponse(approvalRow), "an approval closes as a deny").toMatchObject({ behavior: "deny" });
    expect(choicesOf(approvalRow)).toEqual([]);
  });
});

const news = (id: string, at: number, extra: Partial<InboxRow> = {}): InboxRow => ({
  id, kind: "message", tab: "info", unread: false, at, from: { name: "Scout", botId: "scout" }, text: id,
  origin: { botId: "scout", threadId: "scout-main", title: "Launch" }, ...extra,
});

describe("grouped news", () => {
  it("tells news from a decision", () => {
    const flagged = news("flagged", 1, { decision: true });
    expect([approvalRow, questionRow, messageRow, reportRow, flagged].map(isNews)).toEqual([false, false, true, true, false]);
    expect([approvalRow, questionRow, messageRow, reportRow, flagged, settledRow].map(isDecision)).toEqual([true, true, false, false, true, false]);
  });

  it("lists decisions first, then news, each newest first", () => {
    const flagged = news("flagged", 10, { decision: true });
    const newer = news("newer", 5000);
    expect(listedRows(inboxView([newer, flagged, questionRow, approvalRow])).map((row) => row.id)).toEqual([approvalRow.id, questionRow.id, "flagged", "newer"]);
  });

  it("groups two or more news lines of one bot in one conversation, at the place of the newest", () => {
    const rows = [news("a", 50), approvalRow, news("b", 40), news("other-chat", 30, { origin: { botId: "scout", threadId: "scout-two", title: "Two" } }), news("c", 20)];
    const items = inboxItems(rows);
    expect(items.map((item) => (item.kind === "row" ? item.row.id : item.rows.map((row) => row.id)))).toEqual([["a", "b", "c"], approvalRow.id, "other-chat"]);
  });

  it("puts a group's lines newest first even when the input is not", () => {
    const [item] = inboxItems([news("old", 1), news("new", 9)]);
    expect(item).toMatchObject({ kind: "group", rows: [{ id: "new" }, { id: "old" }] });
  });

  it("never groups a line without a conversation, an ask, a decision, or another bot's line", () => {
    const rows = [news("x", 9, { origin: undefined }), news("y", 8, { origin: undefined }), news("d1", 7, { decision: true }), news("d2", 6, { decision: true }),
      news("other", 5, { from: { name: "Reporter", botId: "reporter" } }), news("mine", 4)];
    expect(inboxItems(rows).every((item) => item.kind === "row")).toBe(true);
  });

  it("falls back to the sender's name when a line has no bot", () => {
    const rows = [news("p", 9, { from: { name: "Cleo" } }), news("q", 8, { from: { name: "Cleo" } })];
    expect(inboxItems(rows)).toMatchObject([{ kind: "group", rows: [{ id: "p" }, { id: "q" }] }]);
  });

  it("counts each open decision once, read or not, and unread news", () => {
    const view = inboxView([{ ...approvalRow, unread: false }, news("read-decision", 3, { decision: true, unread: false }), news("unread-decision", 3, { decision: true, unread: true }),
      news("unread", 2, { unread: true }), news("read", 1), settledRow]);
    expect(waitingCount(view)).toBe(4);
  });
});
