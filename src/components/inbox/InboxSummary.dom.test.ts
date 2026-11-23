// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string; body?: any }>,
  view: null as null | { rows: unknown[] },
  hold: null as null | Promise<void>,
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("../../state/api", () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    server.calls.push({ path, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (path === "/api/inbox/summary" && server.hold) await server.hold;
    return server.view;
  }),
}));

import { initialState, StoreContext, type AppState, type Bot } from "@/state/store";
import { closeInbox, currentInboxSummarizing, openInbox, requestInboxSummary, setInboxView } from "@/state/inbox";
import { INBOX_NOW, approvalRow, inboxView } from "@/testing/inbox-fixture";
import type { InboxRow, InboxSummary, InboxView } from "../../../shared/inbox";
import { InboxPanel } from "./InboxPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bots = [{ id: "seira", name: "Seira", color: "blue" }, { id: "scout", name: "Scout", color: "red" }, { id: "secret", name: "Secret", color: "green", hidden: true }] as Bot[];
let root: Root;
const mount = (child: ReactElement) => act(async () => {
  root.render(createElement(StoreContext.Provider,
    { value: { state: { ...initialState, bots } as AppState, dispatch: vi.fn(), flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn() } as never }, child));
});
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const click = (selector: string) => act(async () => { document.querySelector<HTMLElement>(selector)!.click(); });
const shown = (view: InboxView) => { server.view = view; setInboxView(view); };

const news = (id: string, thread: string, minutes: number, over: Partial<InboxRow> = {}): InboxRow => ({
  id, kind: "message", tab: "info", unread: false, at: INBOX_NOW - minutes * 60_000, replies: true, from: { name: "Scout", botId: "scout" },
  origin: { botId: "scout", threadId: thread, title: `Chat ${thread}` }, text: `Text of ${id}`, ...over,
});
const rows = [
  news("n1", "t-pricing", 1), news("n2", "t-pricing", 2), news("n3", "t-launch", 3), news("n4", "t-invoice", 4, { decision: true, text: "Approve the invoice for Friday?" }),
  news("n5", "t-misc", 5),
];
const summary: InboxSummary = {
  id: "sum-1", at: INBOX_NOW, by: { botId: "seira", name: "Seira" }, covers: ["n1", "n2", "n3", "n4", "n5"],
  items: [
    { botId: "scout", threadId: "t-pricing", title: "Chat t-pricing", text: "Pricing page is live.", important: true, rowIds: ["n1", "n2"] },
    { botId: "scout", threadId: "t-launch", title: "Chat t-launch", text: "Launch moved to Friday.", important: true, rowIds: ["n3"] },
    { botId: "scout", threadId: "t-invoice", title: "Chat t-invoice", text: "An invoice waits.", important: false, rowIds: ["n4"] },
    { botId: "scout", threadId: "t-misc", title: "Chat t-misc", text: "Backups ran.", important: false, rowIds: ["n5"] },
  ],
};
const withSummary = (): InboxView => ({ ...inboxView([approvalRow, ...rows]), summary, summarizer: { botId: "seira" } });

beforeEach(() => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  server.calls.length = 0;
  server.hold = null;
  shown(withSummary());
});
afterEach(() => {
  act(() => root.unmount());
  closeInbox();
  setInboxView(null);
  document.body.innerHTML = "";
});

describe("the summary card", () => {
  it("AC-14: names who wrote it, takes decisions from the rows, gives one sentence per conversation, and folds the rest", async () => {
    await mount(createElement(InboxPanel));
    const card = document.querySelector<HTMLElement>("[data-inbox-summary]")!;
    expect(card.querySelector("h3")!.textContent).toBe("Summary");
    expect(card.querySelector("[data-inbox-summary-by]")!.textContent).toBe("Written by Seira from 5 messages");
    const decisions = [...card.querySelectorAll<HTMLElement>("[data-inbox-summary-decision]")];
    expect(decisions.map((one) => one.dataset.inboxSummaryDecision)).toEqual(["n4"]);
    expect(decisions[0]!.textContent).toContain("Approve the invoice for Friday?");
    expect(decisions[0]!.textContent, "the decision is the row's own text, not the writer's sentence").not.toContain("An invoice waits.");
    const worth = [...card.querySelectorAll<HTMLElement>("[data-inbox-summary-worth] [data-inbox-summary-item]")];
    expect(worth.map((one) => one.dataset.inboxSummaryItem)).toEqual(["t-pricing", "t-launch"]);
    expect(worth[0]!.textContent).toContain("Pricing page is live.");
    const more = card.querySelector<HTMLDetailsElement>("details[data-inbox-summary-more]")!;
    expect(more.open).toBe(false);
    expect(more.querySelector("summary")!.textContent).toBe("1 more updates");
    expect([...more.querySelectorAll<HTMLElement>("[data-inbox-summary-item]")].map((one) => one.dataset.inboxSummaryItem)).toEqual(["t-misc"]);
    expect(card.textContent, "a decision conversation is not repeated as news").not.toContain("An invoice waits.");
    expect(document.querySelector("[data-inbox-list]")!.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it("opens the newest line of a conversation, and a decision's own row, in the panel", async () => {
    await mount(createElement(InboxPanel));
    await click('[data-inbox-summary-item="t-pricing"]');
    expect(document.querySelector('[data-inbox-reading="n1"]')).not.toBeNull();
  });

  it("AC-15: Done sends only the covered news that is still open, never the decision or an ask", async () => {
    await mount(createElement(InboxPanel));
    await click("[data-inbox-summary-done]");
    await settle();
    const done = server.calls.find((call) => call.path === "/api/inbox/done-all")!;
    expect(done.method).toBe("POST");
    expect([...done.body.ids].sort()).toEqual(["n1", "n2", "n3", "n5"]);
    expect(done.body.ids).not.toContain("n4");
    expect(done.body.ids).not.toContain(approvalRow.id);
  });

  it("hides on Hide and counts Not useful, each through the server", async () => {
    await mount(createElement(InboxPanel));
    await click("[data-inbox-summary-hide]");
    await settle();
    expect(server.calls).toContainEqual({ path: "/api/inbox/summary/hide", method: "POST", body: { wrong: false } });
    shown(withSummary());
    await settle();
    await click("[data-inbox-summary-wrong]");
    await settle();
    expect(server.calls).toContainEqual({ path: "/api/inbox/summary/hide", method: "POST", body: { wrong: true } });
  });

  it("is gone from the list while the person searches, and gives way to nothing when there is no summary", async () => {
    await mount(createElement(InboxPanel));
    const search = document.querySelector<HTMLInputElement>("input[type=search]")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "pricing");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.querySelector("[data-inbox-summary]")).toBeNull();
    shown(inboxView([approvalRow, ...rows]));
    await settle();
    expect(document.querySelector("[data-inbox-summary]")).toBeNull();
  });

  it("shows one quiet line while the first summary is being written", async () => {
    shown({ ...inboxView([approvalRow, ...rows]), summarizer: { botId: "seira" } });
    let release: () => void = () => undefined;
    server.hold = new Promise<void>((resolve) => { release = resolve; });
    await mount(createElement(InboxPanel));
    expect(document.querySelector("[data-inbox-summary-working]")).toBeNull();
    let writing: Promise<void> = Promise.resolve();
    await act(async () => { writing = requestInboxSummary(true); });
    expect(currentInboxSummarizing()).toBe(true);
    expect(document.querySelector("[data-inbox-summary-working]")!.textContent).toBe("Summarizing your news…");
    server.view = withSummary();
    await act(async () => { release(); await writing; });
    expect(currentInboxSummarizing()).toBe(false);
    expect(document.querySelector("[data-inbox-summary-working]")).toBeNull();
    expect(document.querySelector("[data-inbox-summary]")).not.toBeNull();
  });
});

describe("the Inbox options menu", () => {
  const openMenu = async () => { await mount(createElement(InboxPanel)); await click('button[aria-label="Inbox options"]'); };
  const items = () => [...document.querySelectorAll<HTMLElement>("[data-menu-key]")];

  it("AC-20: lists the bots the person can see and Off, with the default bot chosen when nothing is saved", async () => {
    shown({ ...inboxView([approvalRow, ...rows]), summarizer: { botId: "seira" } });
    await openMenu();
    expect(items().map((one) => one.dataset.menuKey)).toEqual(["summarize", "writer-seira", "writer-scout", "writer-off"]);
    expect(items().filter((one) => one.getAttribute("aria-checked") === "true").map((one) => one.dataset.menuKey)).toEqual(["writer-seira"]);
    expect(document.body.textContent).toContain("Summary written by");
    expect(items().find((one) => one.dataset.menuKey === "writer-secret")).toBeUndefined();
  });

  it("checks Off when the writer is off, and picking a bot or Off tells the server", async () => {
    shown({ ...inboxView([approvalRow, ...rows]), summarizer: { botId: null } });
    await openMenu();
    expect(items().filter((one) => one.getAttribute("aria-checked") === "true").map((one) => one.dataset.menuKey)).toEqual(["writer-off"]);
    await click('[data-menu-key="writer-scout"]');
    await settle();
    expect(server.calls).toContainEqual({ path: "/api/inbox/summarizer", method: "POST", body: { botId: "scout" } });
    await click('button[aria-label="Inbox options"]');
    await click('[data-menu-key="writer-off"]');
    await settle();
    expect(server.calls).toContainEqual({ path: "/api/inbox/summarizer", method: "POST", body: { botId: null } });
  });

  it("Summarize now writes at once, and says why it cannot with fewer than two news items", async () => {
    shown({ ...inboxView([approvalRow, ...rows]), summarizer: { botId: "seira" } });
    await openMenu();
    const now = () => document.querySelector<HTMLButtonElement>('[data-menu-key="summarize"]')!;
    expect(now().disabled).toBe(false);
    await click('[data-menu-key="summarize"]');
    await settle();
    expect(server.calls).toContainEqual({ path: "/api/inbox/summary", method: "POST", body: { force: true } });
    closeInbox();
    shown({ ...inboxView([approvalRow, rows[0]!]), summarizer: { botId: "seira" } });
    await act(async () => { document.querySelector<HTMLElement>('button[aria-label="Inbox options"]')!.click(); });
    expect(now().disabled).toBe(true);
    expect(now().textContent).toContain("Needs two or more news items.");
  });

  it("has no menu where no summary is written", async () => {
    shown(inboxView([approvalRow, ...rows]));
    await mount(createElement(InboxPanel));
    expect(document.querySelector('button[aria-label="Inbox options"]')).toBeNull();
  });
});

describe("opening the panel", () => {
  it("does not ask for a summary when the one on hand covers the unread news", async () => {
    shown({ ...withSummary(), rows: withSummary().rows.map((row) => ({ ...row, unread: true })) });
    openInbox();
    await mount(createElement(InboxPanel));
    await settle();
    expect(server.calls.map((call) => call.path)).toEqual(["/api/inbox"]);
  });
});
