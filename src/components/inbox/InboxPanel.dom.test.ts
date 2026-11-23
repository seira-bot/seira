// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({ calls: [] as Array<{ path: string; method: string; body?: unknown }>, view: null as null | { rows: Array<{ id: string; tab: string }> } }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("../../state/api", () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    server.calls.push({ path, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const done = /^\/api\/inbox\/([\w-]+)\/done$/.exec(path);
    if (done && server.view) server.view = { ...server.view, rows: server.view.rows.map((row) => (row.id === done[1] ? { ...row, tab: "done", unread: false } : row)) };
    const notDecision = /^\/api\/inbox\/([\w-]+)\/not-decision$/.exec(path);
    if (notDecision && server.view) server.view = { ...server.view, rows: server.view.rows.map((row) => (row.id === notDecision[1] ? { ...row, decision: undefined } : row)) };
    if (path === "/api/inbox/done-all" && server.view) {
      const ids = (JSON.parse(String(init?.body ?? "{}")) as { ids?: string[] }).ids;
      server.view = { ...server.view, rows: server.view.rows.map((row) => (ids ? ids.includes(row.id) : row.tab === "info") ? { ...row, tab: "done", unread: false } : row) };
    }
    if (path === "/api/inbox/read-all" && server.view) server.view = { ...server.view, rows: server.view.rows.map((row) => ({ ...row, unread: false })) };
    return server.view;
  }),
}));

import { initialState, StoreContext, type AppState, type Bot } from "@/state/store";
import { BOT_BUTTON, botButtonTone } from "@/lib/bot-button";
import { closeInbox, currentInbox, currentInboxPanel, inboxVersion, openInbox, setInboxView, useInboxLoader } from "@/state/inbox";
import { INBOX_NOW, approvalRow, inboxView, messageRow, questionRow, reportRow, settledRow } from "@/testing/inbox-fixture";
import type { InboxRow, InboxView } from "../../../shared/inbox";
import { InboxCardSlot } from "./InboxCard";
import { InboxPanel } from "./InboxPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
const dispatch = vi.fn();
const mount = (child: ReactElement, bots: Bot[] = []) => act(async () => {
  root.render(createElement(StoreContext.Provider,
    { value: { state: { ...initialState, bots } as AppState, dispatch, flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn() } as never }, child));
});
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const click = (selector: string) => act(async () => { document.querySelector<HTMLElement>(selector)!.click(); });
const shown = (view: InboxView) => { server.view = view; setInboxView(view); };

beforeEach(() => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  server.calls.length = 0;
  dispatch.mockClear();
  shown(inboxView());
});
afterEach(() => {
  act(() => root.unmount());
  closeInbox();
  setInboxView(null);
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("the inbox panel", () => {
  it("is one list, newest first, with a dot on what waits on the person and no tabs, and reads one line in full", async () => {
    openInbox();
    await mount(createElement(InboxPanel));
    expect(document.querySelector("[role=tablist], [data-inbox-tab]")).toBeNull();
    const listed = () => [...document.querySelectorAll<HTMLElement>("[data-inbox-row]")].map((row) => row.dataset.inboxRow);
    expect(listed()).toEqual([approvalRow.id, questionRow.id, messageRow.id, reportRow.id]);
    expect(listed(), "a settled line is not listed again").not.toContain(settledRow.id);
    expect([...document.querySelectorAll<HTMLElement>("[data-inbox-row] [data-inbox-waits]")].map((dot) => dot.closest<HTMLElement>("[data-inbox-row]")!.dataset.inboxRow)).toEqual([approvalRow.id, questionRow.id]);
    expect(document.querySelector(`[data-inbox-row="${approvalRow.id}"]`)!.hasAttribute("data-unread")).toBe(true);
    await click(`[data-inbox-row="${messageRow.id}"] button`);
    expect(document.querySelector(`[data-inbox-reading="${messageRow.id}"]`)?.textContent).toContain("The launch moved to Friday.");
    expect(server.calls).toContainEqual({ path: `/api/inbox/${messageRow.id}/read`, method: "POST" });
    expect(document.querySelector("textarea"), "a message that waits on an answer takes a reply").not.toBeNull();
    await click('[aria-label="Back to the list"]');
    expect(listed()).toEqual([approvalRow.id, questionRow.id, messageRow.id, reportRow.id]);
  });

  it("answers an ask from its row through the copy's own card, as the chat's buttons do, and marks news done", async () => {
    openInbox();
    await mount(createElement(InboxPanel));
    const exit = () => new Promise((resolve) => setTimeout(resolve, 260));
    await click(`[data-inbox-row="${approvalRow.id}"] [data-inbox-action="allow"]`);
    await exit();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "decideRequest", threadId: "inbox", requestId: "req-approval", behavior: "allow" }));
    await click(`[data-inbox-row="${questionRow.id}"] [data-inbox-action="close"]`);
    await exit();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "decideRequest", threadId: "inbox", requestId: "req-question", behavior: "answer" }));
    await click(`[data-inbox-row="${reportRow.id}"] [data-inbox-action="done"]`);
    expect(document.querySelector(`[data-inbox-row="${reportRow.id}"]`)?.hasAttribute("inert"), "it slides out first").toBe(true);
    await exit();
    expect(server.calls).toContainEqual({ path: `/api/inbox/${reportRow.id}/done`, method: "POST" });
    expect(document.querySelector(`[data-inbox-row="${reportRow.id}"]`), "it leaves the list after its exit").toBeNull();
  });

  it("marks every unread line read from one control that only shows while something is unread, and answers no ask", async () => {
    openInbox();
    await mount(createElement(InboxPanel));
    const rowIds = () => [...document.querySelectorAll<HTMLElement>("[data-inbox-row]")].map((row) => row.dataset.inboxRow);
    const unreadIds = () => [...document.querySelectorAll<HTMLElement>("[data-inbox-row][data-unread]")].map((row) => row.dataset.inboxRow);
    expect(unreadIds()).toEqual([approvalRow.id, messageRow.id]);
    expect(document.querySelector("[data-inbox-mark-all]")!.textContent).toBe("Mark all as read");
    await click("[data-inbox-mark-all]");
    expect(server.calls).toContainEqual({ path: "/api/inbox/read-all", method: "POST" });
    expect(unreadIds()).toEqual([]);
    expect(rowIds(), "every row is still listed").toEqual([approvalRow.id, questionRow.id, messageRow.id, reportRow.id]);
    expect(document.querySelector(`[data-inbox-row="${approvalRow.id}"] [data-inbox-action="allow"]`), "the ask still waits on its answer").not.toBeNull();
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "decideRequest" }));
    expect(server.calls.filter((call) => /\/(done)$/.test(call.path))).toEqual([]);
    expect(currentInbox()!.rows.map((row) => [row.id, row.tab])).toEqual(inboxView().rows.map((row) => [row.id, row.tab]));
    expect(document.querySelector("[data-inbox-mark-all]"), "nothing is unread").toBeNull();
  });

  it("keeps the control out of an inbox with nothing unread", async () => {
    shown(inboxView([{ ...approvalRow, unread: false }, { ...messageRow, unread: false }]));
    openInbox();
    await mount(createElement(InboxPanel));
    expect(document.querySelector("[data-inbox-row]")).not.toBeNull();
    expect(document.querySelector("[data-inbox-mark-all]")).toBeNull();
  });

  it("is a sheet at phone width", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width"), addEventListener() {}, removeEventListener() {} }));
    openInbox();
    await mount(createElement(InboxPanel));
    expect(document.querySelector('[data-inbox-panel="sheet"]')).not.toBeNull();
    expect(document.querySelector('[data-inbox-panel="side"]')).toBeNull();
  });
});

describe("grouped news in the panel", () => {
  const update = (id: string, minutes: number): InboxRow => ({
    id, kind: "message", tab: "info", unread: id === "up-3", at: INBOX_NOW - minutes * 60_000, replies: true, from: { name: "Scout", botId: "scout" },
    origin: { botId: "scout", threadId: "scout-main", title: "Launch page" }, text: `Update ${id}`,
  });
  const grouped = () => shown(inboxView([approvalRow, update("up-3", 1), update("up-2", 5), update("up-1", 9), reportRow]));
  const exit = () => new Promise((resolve) => setTimeout(resolve, 260));

  it("shows one card with the newest line and the count, and expands to every line newest first", async () => {
    grouped();
    openInbox();
    await mount(createElement(InboxPanel));
    const group = document.querySelector<HTMLElement>("[data-inbox-group]")!;
    expect(group.dataset.inboxGroupCount).toBe("3");
    expect(group.querySelector("[data-inbox-group-chip]")!.textContent).toBe("3 updates");
    expect(group.querySelectorAll("[data-inbox-row]")).toHaveLength(1);
    expect(group.textContent).toContain("Update up-3");
    expect(document.querySelector("[data-inbox-group-rows]")).toBeNull();
    await click("[data-inbox-group-toggle]");
    expect([...group.querySelectorAll<HTMLElement>("[data-inbox-group-row]")].map((line) => line.dataset.inboxGroupRow)).toEqual(["up-3", "up-2", "up-1"]);
    expect(document.querySelector("[data-inbox-group-toggle]")!.textContent).toBe("Show less");
    await click('[data-inbox-group-row="up-2"]');
    expect(document.querySelector('[data-inbox-reading="up-2"]')).not.toBeNull();
  });

  it("labels the decisions and the news when both are listed", async () => {
    grouped();
    openInbox();
    await mount(createElement(InboxPanel));
    expect([...document.querySelectorAll<HTMLElement>("[data-inbox-section]")].map((label) => label.textContent)).toEqual(["Needs your decision", "News"]);
  });

  it("labels a message that looks like a decision, and Not a decision sends it down to the news", async () => {
    shown(inboxView([approvalRow, { ...messageRow, decision: true }, reportRow]));
    openInbox();
    await mount(createElement(InboxPanel));
    const row = () => document.querySelector<HTMLElement>(`[data-inbox-row="${messageRow.id}"]`)!;
    const sectionOf = () => {
      const labels = [...document.querySelectorAll<HTMLElement>("[data-inbox-section]")];
      return labels.filter((label) => label.compareDocumentPosition(row()) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1)?.textContent;
    };
    expect(row().querySelector("[data-inbox-decision-label]")!.textContent).toBe("Looks like it needs your decision");
    expect(row().querySelector("[data-inbox-not-decision]")!.textContent).toBe("Not a decision");
    expect([...row().querySelectorAll("[data-inbox-action]")].map((one) => (one as HTMLElement).dataset.inboxAction)).toEqual(["done", "open"]);
    expect(sectionOf()).toBe("Needs your decision");
    expect(document.querySelector(`[data-inbox-row="${reportRow.id}"] [data-inbox-not-decision]`)).toBeNull();
    await click(`[data-inbox-row="${messageRow.id}"] [data-inbox-not-decision]`);
    await settle();
    expect(server.calls).toContainEqual({ path: `/api/inbox/${messageRow.id}/not-decision`, method: "POST" });
    expect(row().querySelector("[data-inbox-decision-label], [data-inbox-not-decision]")).toBeNull();
    expect(sectionOf()).toBe("News");
  });

  it("marks every line of a group done from one Done", async () => {
    grouped();
    openInbox();
    await mount(createElement(InboxPanel));
    await click('[data-inbox-group] [data-inbox-action="done"]');
    await exit();
    expect(server.calls).toContainEqual({ path: "/api/inbox/done-all", method: "POST", body: { ids: ["up-3", "up-2", "up-1"] } });
    expect(document.querySelector("[data-inbox-group]")).toBeNull();
    expect(document.querySelector(`[data-inbox-row="${reportRow.id}"]`), "other news stays").not.toBeNull();
  });

  it("marks all news done and leaves the asks", async () => {
    grouped();
    openInbox();
    await mount(createElement(InboxPanel));
    expect(document.querySelector("[data-inbox-done-all]")!.textContent).toBe("Done all news");
    await click("[data-inbox-done-all]");
    expect(server.calls).toContainEqual({ path: "/api/inbox/done-all", method: "POST", body: {} });
    expect([...document.querySelectorAll<HTMLElement>("[data-inbox-row]")].map((row) => row.dataset.inboxRow)).toEqual([approvalRow.id]);
    expect(document.querySelector("[data-inbox-done-all]"), "no news is left").toBeNull();
  });
});

describe("the inbox's card in the chat", () => {
  const lines = (ids: string[]) => createElement("div", null, ...ids.map((id) => createElement(InboxCardSlot, { key: id, threadId: "inbox", messageId: id })));

  it("sits once, under the newest line that needed the person, and opens the inbox", async () => {
    await mount(lines([settledRow.id, reportRow.id, messageRow.id, questionRow.id, approvalRow.id]));
    expect(document.querySelectorAll("[data-inbox-card]")).toHaveLength(1);
    expect(document.querySelector('[data-inbox-card="open"]')!.getAttribute("aria-label")).toBe("2 need you · 2 for your info");
    expect([...document.querySelectorAll("[data-inbox-card] [data-inbox-row]")].map((row) => (row as HTMLElement).dataset.inboxRow)).toEqual([approvalRow.id, questionRow.id]);
    expect([...document.querySelectorAll('[data-inbox-card] [data-inbox-action="allow"]')].filter((button) => !button.closest("[data-inbox-row]")),
      "the line the card sits under answers on its own card").toEqual([]);
    await click('[data-inbox-card] [data-inbox-choice="Pricing"]');
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "decideRequest", threadId: "inbox", requestId: "req-question", behavior: "answer", message: "Pricing" }));
    await click('[data-inbox-card] header button');
    expect(currentInboxPanel()).toMatchObject({ open: true, reading: null });
    await mount(createElement(InboxCardSlot, { threadId: "elsewhere", messageId: approvalRow.id }));
    expect(document.querySelector("[data-inbox-card]"), "never in another conversation").toBeNull();
  });

  it("shrinks to one line when nothing waits, and moves under a new ask once it lands", async () => {
    const caughtUp = inboxView([messageRow, reportRow, { ...settledRow }]);
    shown({ ...caughtUp, anchor: settledRow.id });
    await mount(lines([settledRow.id, reportRow.id, messageRow.id]));
    expect(document.querySelector('[data-inbox-card="caught-up"]')?.textContent).toContain("All caught up · 2 for your info");
    const later = { ...approvalRow, id: "line-later" };
    await act(async () => { shown({ ...inboxView([later, messageRow, reportRow, settledRow]), anchor: later.id }); });
    await mount(lines([settledRow.id, reportRow.id, messageRow.id, later.id]));
    const cards = document.querySelectorAll("[data-inbox-card]");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.getAttribute("data-inbox-card")).toBe("open");
  });
});

describe("answer buttons in the asking bot's colour", () => {
  const reporter = { id: "reporter", name: "Reporter", color: "orange" } as Bot;
  /** The answer under a line, not the quick action on the row itself. */
  const answer = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].find((button) => !button.closest("[data-inbox-row]"))!;
  const own = (selector: string) => {
    const button = answer(selector);
    expect(button.className.split(" ")).toContain(BOT_BUTTON);
    expect(button.style.getPropertyValue("--bot-button")).toBe(botButtonTone("orange").fill);
    expect(button.style.getPropertyValue("--bot-button-ink")).toBe(botButtonTone("orange").ink);
  };

  it("paints Allow on the chat's card and in the panel in the colour of the bot the line is from", async () => {
    shown({ ...inboxView(), anchor: questionRow.id });
    await mount(createElement(InboxCardSlot, { threadId: "inbox", messageId: questionRow.id }), [reporter]);
    own('[data-inbox-card] [data-inbox-action="allow"]');
    expect(answer('[data-inbox-card] [data-inbox-action="deny"]').className.split(" ")).not.toContain(BOT_BUTTON);
    openInbox({ reading: approvalRow.id });
    await mount(createElement(InboxPanel), [reporter]);
    own('[data-inbox-reading] [data-inbox-action="allow"]');
  });

  it("keeps the plain primary for a teammate's line and for a bot this app does not know", async () => {
    openInbox({ reading: messageRow.id });
    await mount(createElement(InboxPanel), [reporter]);
    const send = document.querySelector<HTMLElement>('[data-inbox-reading] button[type="submit"]')!;
    expect(send.className.split(" ")).not.toContain(BOT_BUTTON);
    expect(send.className.split(" ")).toContain("bg-accent");
    shown({ ...inboxView(), anchor: questionRow.id });
    await mount(createElement(InboxCardSlot, { threadId: "inbox", messageId: questionRow.id }));
    expect(answer('[data-inbox-card] [data-inbox-action="allow"]').className.split(" ")).not.toContain(BOT_BUTTON);
  });
});

describe("keeping the list live", () => {
  function Loader({ version }: { version: string }) {
    useInboxLoader(version);
    return null;
  }

  it("reads the list again whenever what it depends on changes", async () => {
    const task = (inboxChangedAt?: number, openAsks?: number) => [{ id: "bens-chief", tasks: [{ threadId: "inbox", inbox: true as const, ...(inboxChangedAt ? { inboxChangedAt } : {}), ...(openAsks ? { openAsks } : {}) }] }];
    expect(inboxVersion([{ id: "solo", tasks: [{ threadId: "t1" }] }]), "nothing is anyone's inbox off a team").toBeNull();
    const first = inboxVersion(task(5, 2));
    expect(inboxVersion(task(6, 2))).not.toBe(first);
    expect(inboxVersion(task(5, 1))).not.toBe(first);
    await mount(createElement(Loader, { version: first! }));
    await settle();
    const reads = () => server.calls.filter((call) => call.path === "/api/inbox").length;
    expect(reads()).toBe(1);
    await mount(createElement(Loader, { version: first! }));
    await settle();
    expect(reads(), "the same version reads nothing").toBe(1);
    await mount(createElement(Loader, { version: inboxVersion(task(6, 1))! }));
    await settle();
    expect(reads()).toBe(2);
  });
  it("reads once more 5 seconds after a change, so a sort verdict that lands late shows up", async () => {
    vi.useFakeTimers();
    try {
      const reads = () => server.calls.filter((call) => call.path === "/api/inbox").length;
      const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
      await mount(createElement(Loader, { version: "a" }));
      await wait(0);
      expect(reads()).toBe(1);
      await wait(4_900);
      expect(reads()).toBe(1);
      await mount(createElement(Loader, { version: "b" }));
      await wait(0);
      expect(reads(), "a change reads at once and restarts the wait").toBe(2);
      await wait(4_900);
      expect(reads()).toBe(2);
      await wait(200);
      expect(reads(), "one more read, 5 seconds after the last change").toBe(3);
      await wait(30_000);
      expect(reads(), "exactly one").toBe(3);
      await mount(createElement(Loader, { version: "c" }));
      await wait(0);
      expect(reads()).toBe(4);
      await act(async () => root.unmount());
      await wait(10_000);
      expect(reads(), "unmounting clears the wait").toBe(4);
      root = createRoot(document.body.appendChild(document.createElement("div")));
    } finally {
      vi.useRealTimers();
    }
  });
});
