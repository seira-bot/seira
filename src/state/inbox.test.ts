import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InboxRow, InboxView } from "../../shared/inbox";
import { approvalRow, inboxView, messageRow, reportRow } from "@/testing/inbox-fixture";
import { api } from "./api";
import { closeInbox, currentInbox, currentInboxSummarizing, doneAllInboxNews, doneInboxRow, doneInboxRows, hideInboxSummary, notDecisionInboxRow, openInbox, readInboxRow, refreshInbox, requestInboxSummary, setInboxSummarizer, setInboxView } from "./inbox";

vi.mock("./api", () => ({ api: vi.fn() }));

type Request = { path: string; resolve: (view: InboxView) => void; reject: (error: Error) => void; settled?: boolean };
let requests: Request[];
const done = inboxView([{ ...messageRow, unread: false, tab: "done" }]);
const flush = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };
const reply = async (index: number, view: InboxView) => {
  requests[index]!.settled = true;
  requests[index]!.resolve(view);
  await flush();
};
const fail = async (index: number) => {
  requests[index]!.settled = true;
  requests[index]!.reject(new Error("offline"));
  await flush();
};

beforeEach(() => {
  requests = [];
  vi.mocked(api).mockImplementation((path) => new Promise<InboxView>((resolve, reject) => {
    requests.push({ path, resolve, reject });
  }));
  setInboxView(inboxView([messageRow]));
});
afterEach(async () => {
  closeInbox();
  for (let n = 0; n < requests.length; n++) {
    if (!requests[n]!.settled) await reply(n, done);
  }
  setInboxView(null);
  vi.clearAllMocks();
});

it("keeps Done when the read sent before it answers last", async () => {
  readInboxRow(messageRow);
  doneInboxRow(messageRow);
  await reply(1, done);
  await reply(0, inboxView([{ ...messageRow, unread: false }]));
  expect(currentInbox()?.rows[0]).toMatchObject({ tab: "done", unread: false });
  expect(requests.map((request) => request.path)).toEqual(["/api/inbox/line-message/read", "/api/inbox/line-message/done"]);
});

it("drops a list read before Done, whichever answers first", async () => {
  const loading = refreshInbox();
  doneInboxRow(messageRow);
  await reply(0, inboxView([messageRow]));
  expect(currentInbox()?.rows[0]?.tab).toBe("done");
  await reply(1, done);
  await loading;
  expect(currentInbox()?.rows[0]?.tab).toBe("done");

  setInboxView(inboxView([messageRow]));
  const again = refreshInbox();
  doneInboxRow(messageRow);
  await reply(3, done);
  await reply(2, inboxView([messageRow]));
  await again;
  expect(currentInbox()?.rows[0]?.tab).toBe("done");
});

it("keeps a newer list when an older read answers after it", async () => {
  readInboxRow(messageRow);
  const loading = refreshInbox();
  await reply(1, inboxView([{ ...messageRow, unread: false, text: "Newer text" }]));
  await loading;
  await reply(0, inboxView([{ ...messageRow, unread: false }]));
  expect(currentInbox()?.rows[0]?.text).toBe("Newer text");
});

it.each(["done", "read"] as const)("puts the row back when %s fails and the read after it fails too", async (what) => {
  if (what === "done") doneInboxRow(messageRow);
  else readInboxRow(messageRow);
  expect(currentInbox()?.rows[0]?.unread).toBe(false);
  await fail(0);
  expect(currentInbox()?.rows[0]).toMatchObject({ tab: "info", unread: true });
  expect(requests[1]?.path).toBe("/api/inbox");
  await fail(1);
  expect(requests).toHaveLength(2);
  expect(currentInbox()?.rows[0]).toMatchObject({ tab: "info", unread: true });

  const loading = refreshInbox();
  await reply(2, inboxView([{ ...messageRow, text: "Reconciled text", unread: false }]));
  await loading;
  expect(currentInbox()?.rows[0]).toMatchObject({ tab: "info", unread: false, text: "Reconciled text" });
});

it("moves the named lines to Done together, and puts each back when the server cannot be told", async () => {
  setInboxView(inboxView([approvalRow, messageRow, reportRow]));
  doneInboxRows([messageRow, reportRow]);
  expect(currentInbox()?.rows.map((row) => row.tab)).toEqual(["needs-you", "done", "done"]);
  await fail(0);
  expect(requests[0]).toMatchObject({ path: "/api/inbox/done-all" });
  expect(vi.mocked(api).mock.calls[0]![1]).toMatchObject({ method: "POST", body: JSON.stringify({ ids: [messageRow.id, reportRow.id] }) });
  expect(currentInbox()?.rows.map((row) => [row.tab, row.unread])).toEqual([["needs-you", true], ["info", true], ["info", false]]);
});

it("moves all news to Done with an empty body, leaves asks, and keeps what the server answers", async () => {
  setInboxView(inboxView([approvalRow, messageRow, reportRow]));
  doneAllInboxNews();
  expect(currentInbox()?.rows.map((row) => row.tab)).toEqual(["needs-you", "done", "done"]);
  expect(vi.mocked(api).mock.calls[0]![1]).toMatchObject({ method: "POST", body: "{}" });
  await reply(0, inboxView([approvalRow, { ...messageRow, tab: "done" }, { ...reportRow, tab: "done" }]));
  expect(currentInbox()?.rows.map((row) => row.tab)).toEqual(["needs-you", "done", "done"]);
});

it("drops a decision mark at once, keeps what the server answers, and puts the mark back when it cannot be told", async () => {
  const flagged = { ...messageRow, decision: true as const };
  setInboxView(inboxView([approvalRow, flagged]));
  void notDecisionInboxRow(flagged);
  expect(currentInbox()?.rows[1]!.decision).toBeUndefined();
  expect(requests[0]).toMatchObject({ path: `/api/inbox/${flagged.id}/not-decision` });
  expect(vi.mocked(api).mock.calls[0]![1]).toMatchObject({ method: "POST" });
  await reply(0, inboxView([approvalRow, messageRow]));
  expect(currentInbox()?.rows[1]!.decision).toBeUndefined();

  setInboxView(inboxView([approvalRow, flagged]));
  void notDecisionInboxRow(flagged);
  await fail(1);
  expect(currentInbox()?.rows[1]!.decision).toBe(true);
  expect(requests[2], "the list is read again").toMatchObject({ path: "/api/inbox" });
});

const unreadNews = (count: number): InboxRow[] => Array.from({ length: count }, (_, i) => ({ ...messageRow, id: `news-${i}`, at: messageRow.at + i }));
const written = (count: number, summarizer: InboxView["summarizer"] = { botId: "seira" }): InboxView => ({ ...inboxView(unreadNews(count)), summarizer });
const paths = () => requests.map((request) => request.path);
const bodyOf = (index: number) => JSON.parse(String(vi.mocked(api).mock.calls[index]![1]!.body));

it("asks for a summary when the panel opens with five unread news lines outside the summary, and only once per opening", async () => {
  const card = { id: "s", at: 1, by: { botId: "seira", name: "Seira" }, covers: [], items: [] };
  openInbox();
  await reply(0, written(5));
  expect(paths()).toEqual(["/api/inbox", "/api/inbox/summary"]);
  expect(bodyOf(1)).toEqual({ force: false });
  expect(currentInboxSummarizing()).toBe(true);
  await reply(1, { ...written(5), summary: card });
  expect(currentInboxSummarizing()).toBe(false);
  expect(currentInbox()?.summary?.id).toBe("s");
  openInbox({ reading: "news-1" });
  await reply(2, { ...written(5), summary: card });
  expect(paths(), "the panel is already open").toEqual(["/api/inbox", "/api/inbox/summary", "/api/inbox"]);
  closeInbox();
  openInbox();
  await reply(3, written(5));
  expect(paths().at(-1), "a new opening asks again").toBe("/api/inbox/summary");
  closeInbox();
});

it("asks for no summary below five unread news lines, with the writer off, or where no summary is written", async () => {
  for (const view of [written(4), written(5, { botId: null }), inboxView(unreadNews(6))]) {
    openInbox();
    await reply(requests.length - 1, view);
    closeInbox();
  }
  expect(paths()).toEqual(["/api/inbox", "/api/inbox", "/api/inbox"]);
  const covered = written(5);
  openInbox();
  await reply(3, { ...covered, summary: { id: "s", at: 1, by: { botId: "seira", name: "Seira" }, covers: ["news-0", "news-1"], items: [] } });
  expect(paths().at(-1), "three unread lines are left outside the summary").toBe("/api/inbox");
  closeInbox();
});

it("shows the inbox a requested summary comes back in, runs one request at a time, and on failure only clears the waiting note", async () => {
  setInboxView(written(3));
  const first = requestInboxSummary(true);
  void requestInboxSummary(true);
  expect(paths()).toEqual(["/api/inbox/summary"]);
  expect(bodyOf(0)).toEqual({ force: true });
  expect(currentInboxSummarizing()).toBe(true);
  await fail(0);
  await first;
  expect(currentInboxSummarizing()).toBe(false);
  expect(currentInbox()).toEqual(written(3));
  const again = requestInboxSummary();
  await reply(1, { ...written(3), summary: { id: "s2", at: 2, by: { botId: "seira", name: "Seira" }, covers: [], items: [] } });
  await again;
  expect(currentInbox()?.summary?.id).toBe("s2");
});

it("hides the summary at once, and reads the list again when the server cannot be told", async () => {
  const card = { id: "s", at: 1, by: { botId: "seira", name: "Seira" }, covers: ["news-0"], items: [] };
  setInboxView({ ...written(2), summary: card });
  const hiding = hideInboxSummary(true);
  expect(currentInbox()?.summary).toBeUndefined();
  expect(currentInbox()?.summarizer).toEqual({ botId: "seira" });
  expect(bodyOf(0)).toEqual({ wrong: true });
  await fail(0);
  await hiding;
  expect(paths()).toEqual(["/api/inbox/summary/hide", "/api/inbox"]);
  await reply(1, { ...written(2), summary: card });
  expect(currentInbox()?.summary).toEqual(card);
});

it("shows a picked writer at once, keeps what the server answers, and reads the list again when it cannot be told", async () => {
  setInboxView(written(2));
  const picking = setInboxSummarizer("scout");
  expect(currentInbox()?.summarizer).toEqual({ botId: "scout" });
  expect(bodyOf(0)).toEqual({ botId: "scout" });
  await reply(0, written(2, { botId: "scout" }));
  await picking;
  const off = setInboxSummarizer(null);
  expect(currentInbox()?.summarizer).toEqual({ botId: null });
  await fail(1);
  await off;
  expect(paths()).toEqual(["/api/inbox/summarizer", "/api/inbox/summarizer", "/api/inbox"]);
});
