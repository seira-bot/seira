import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InboxView } from "../../shared/inbox";
import { approvalRow, inboxView, messageRow, reportRow } from "@/testing/inbox-fixture";
import { api } from "./api";
import { currentInbox, doneAllInboxNews, doneInboxRow, doneInboxRows, notDecisionInboxRow, readInboxRow, refreshInbox, setInboxView } from "./inbox";

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
