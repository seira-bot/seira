// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BoardCard } from "../../../shared/board";

const server = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; body?: Record<string, unknown> }>,
  cards: [] as unknown[],
  loadFails: false,
  taskFails: false,
  closeFails: false,
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/lib/live-events", () => ({ listenLiveFrames: () => () => {} }));
vi.mock("@/state/api", () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    server.calls.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (path === "/api/board") { if (server.loadFails) throw new Error("down"); return { cards: server.cards }; }
    if (path === "/api/board/close") { if (server.closeFails) throw new Error("down"); return { ok: true }; }
    if (path === "/api/auth/session") return {};
    if (path.endsWith("/tasks")) { if (server.taskFails) throw new Error("down"); return { task: { threadId: "new-thread" } }; }
    if (path === "/api/inbox") return inboxFixture.view();
    return {};
  }),
  ApiError: class extends Error {},
}));
const inboxFixture = vi.hoisted(() => ({ view: () => null as unknown }));

import { initialState, StoreContext, type AppState, type Bot } from "@/state/store";
import { resetBoardForTest, setBoardFilter } from "@/state/board";
import { closeInbox, setInboxView } from "@/state/inbox";
import { inboxView, questionRow } from "@/testing/inbox-fixture";
import { BoardPage } from "./BoardPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bot = (id: string, name: string) => ({ id, name, color: "blue", threadId: `${id}-main`, tasks: [] }) as unknown as Bot;
const BOTS = [bot("scout", "Scout"), bot("cleo", "Cleo")];
const card = (id: string, patch: Partial<BoardCard> = {}): BoardCard => ({
  id, kind: "thread", column: "working", state: "running", title: `Title ${id}`, botId: "scout", threadId: `th-${id}`, createdAt: 1, updatedAt: Date.now(), ...patch,
});
const CARDS = [
  card("thread:q", { column: "todo", state: "queued" }),
  card("thread:w1"),
  card("thread:w2", { botId: "cleo" }),
  card("thread:n", { column: "needs-you", state: "needs-input", question: "Which page?", threadId: "scout-main" }),
  card("handoff:h", { kind: "handoff", column: "done", state: "completed", result: "All set", fromBotId: "cleo", brief: "Do it" }),
  card("routine:r1", { kind: "routine", threadId: "run-thread", title: "Daily digest" }),
];

let root: Root;
const dispatch = vi.fn();
const media = (narrow: boolean) => vi.stubGlobal("matchMedia", (query: string) => ({ matches: narrow && query.includes("760"), addEventListener() {}, removeEventListener() {} }));
const mount = () => act(async () => {
  root.render(createElement(StoreContext.Provider,
    { value: { state: { ...initialState, bots: BOTS, groups: [] } as AppState, dispatch, flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn() } as never }, createElement(BoardPage)));
});
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const click = (el: HTMLElement | null) => act(async () => { el!.click(); });
const buttonNamed = (name: string) => [...document.querySelectorAll<HTMLElement>("button")].find((one) => one.textContent?.trim() === name || one.getAttribute("aria-label") === name) ?? null;
const type = (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const key = (el: HTMLElement, name: string) => act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })); });

beforeEach(async () => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  server.calls.length = 0; server.cards = CARDS; server.loadFails = false; server.taskFails = false; server.closeFails = false;
  inboxFixture.view = () => inboxView([questionRow]);
  dispatch.mockClear();
  resetBoardForTest();
  setInboxView(null);
  media(false);
});
afterEach(() => {
  act(() => root.unmount());
  closeInbox(); setInboxView(null); setBoardFilter(null);
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("the Board page", () => {
  it("shows four columns, each with a heading and its count", async () => {
    await mount(); await settle();
    expect([...document.querySelectorAll("h2")].map((h) => h.textContent)).toEqual(["To do1", "Working3", "Needs you1", "Done1"]);
    expect($("[data-board-column=working]")!.querySelectorAll("[data-board-card]")).toHaveLength(3);
    expect($("[data-board-card='handoff:h']")!.textContent).toContain("From Cleo");
    expect($("[data-board-card='routine:r1']")!.textContent).toContain("Daily digest");
  });

  it("opens a card in a panel with its details and closes it with Escape or the close button", async () => {
    await mount(); await settle();
    await click($("[data-board-card='handoff:h']"));
    const panel = $("[data-board-panel]")!;
    expect(panel.textContent).toContain("All set");
    expect(panel.textContent).toContain("Do it");
    expect(buttonNamed("Open conversation")).not.toBeNull();
    await key(buttonNamed("Close")!, "Escape");
    expect($("[data-board-panel]")).toBeNull();
    await click($("[data-board-card='handoff:h']"));
    await click(buttonNamed("Close"));
    expect($("[data-board-panel]")).toBeNull();
  });

  it("answers a waiting card with its Inbox answer", async () => {
    await mount(); await settle();
    await click($("[data-board-card='thread:n']")); await settle();
    expect($("[data-board-panel] [data-inbox-answer-kind='question']")).not.toBeNull();
  });

  it("moves a Needs you card to Done with one button, and says so", async () => {
    await mount(); await settle();
    await click($("[data-board-card='thread:n']")); await settle();
    server.cards = CARDS.map((one) => one.id === "thread:n"
      ? { ...one, column: "done", state: "closed", question: undefined, closedBy: { kind: "person", name: "Rama" }, closedReason: "Handled by phone" } as BoardCard : one);
    await click(buttonNamed("Move to Done")); await settle();
    expect(server.calls.find((call) => call.path === "/api/board/close")?.body).toEqual({ cardId: "thread:n" });
    expect($("[aria-live=polite]")!.textContent).toContain("Moved to Done.");
    expect($("[data-board-column=done] [data-board-card='thread:n']")!.textContent).toContain("Closed by Rama");
    const panel = $("[data-board-panel]")!;
    expect(panel.textContent).toContain("Closed by Rama");
    expect(panel.textContent).toContain("Handled by phone");
    expect(buttonNamed("Move to Done")).toBeNull();
  });

  it("says when a card could not be moved, and keeps the button", async () => {
    server.closeFails = true;
    await mount(); await settle();
    await click($("[data-board-card='thread:n']")); await settle();
    await click(buttonNamed("Move to Done")); await settle();
    expect($("[data-board-panel] [role=alert]")!.textContent).toBe("Couldn't move this card. Try again.");
    expect(buttonNamed("Move to Done")).not.toBeNull();
  });

  it("offers Move to Done only on a Needs you card", async () => {
    await mount(); await settle();
    for (const id of ["thread:q", "thread:w1", "handoff:h"]) {
      await click($(`[data-board-card='${id}']`));
      expect(buttonNamed("Move to Done"), id).toBeNull();
    }
    await click($("[data-board-card='thread:n']"));
    expect(buttonNamed("Move to Done")).not.toBeNull();
  });

  it("hides Move to Done when the person may only view the card's bot", async () => {
    const view = { ...bot("scout", "Scout"), yourAccess: "view" } as unknown as Bot;
    server.cards = [card("thread:v", { column: "needs-you", state: "waiting-on-you" })];
    await act(async () => {
      root.render(createElement(StoreContext.Provider,
        { value: { state: { ...initialState, bots: [view], groups: [] } as AppState, dispatch, flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn() } as never }, createElement(BoardPage)));
    });
    await settle();
    await click($("[data-board-card='thread:v']"));
    expect($("[data-board-panel]")).not.toBeNull();
    expect(buttonNamed("Move to Done")).toBeNull();
  });

  it("names a bot that closed a card", async () => {
    server.cards = [card("thread:c", { column: "done", state: "closed", closedBy: { kind: "bot", botId: "cleo" }, closedReason: "No longer needed" })];
    await mount(); await settle();
    expect($("[data-board-card='thread:c']")!.textContent).toContain("Closed by Cleo");
    await click($("[data-board-card='thread:c']"));
    expect($("[data-board-panel]")!.textContent).toContain("No longer needed");
  });

  it("makes every card a button that a keyboard reaches", async () => {
    await mount(); await settle();
    const cardEl = $("[data-board-card='thread:w1']")!;
    expect(cardEl.tagName).toBe("BUTTON");
    expect(cardEl.getAttribute("tabindex")).not.toBe("-1");
  });

  it("stops a working conversation, and a routine run, and says so", async () => {
    await mount(); await settle();
    await click($("[data-board-card='thread:w1']"));
    await click(buttonNamed("Stop"));
    expect(dispatch).toHaveBeenCalledWith({ type: "interrupt", botId: "scout", threadId: "th-thread:w1" });
    expect($("[aria-live=polite]")!.textContent).toContain("Stopped.");
    await click($("[data-board-card='routine:r1']"));
    await click(buttonNamed("Stop"));
    expect(dispatch).toHaveBeenCalledWith({ type: "cancelRoutineRun", runId: "r1" });
  });

  it("stops a group conversation with the group's own stop", async () => {
    server.cards = [card("thread:g", { groupId: "room", threadId: "room-main" })];
    await mount(); await settle();
    await click($("[data-board-card='thread:g']"));
    await click(buttonNamed("Stop"));
    expect(dispatch).toHaveBeenCalledWith({ type: "interruptGroup", groupId: "room", threadId: "room-main" });
  });

  it("adds a task in two calls and stays on the Board with an empty input", async () => {
    await mount(); await settle();
    await click(buttonNamed("New task"));
    const input = $("[data-board-new-task] input") as HTMLInputElement;
    await type(input, "Write the brief");
    await click(buttonNamed("Add task")); await settle();
    const paths = server.calls.map((call) => call.path).filter((path) => path.startsWith("/api/bots"));
    expect(paths.slice(0, 2)).toEqual([expect.stringMatching(/^\/api\/bots\/\w+\/tasks$/), expect.stringMatching(/^\/api\/bots\/\w+\/messages$/)]);
    expect(server.calls.find((call) => call.path.endsWith("/messages"))!.body).toMatchObject({ text: "Write the brief", threadId: "new-thread" });
    expect((($("[data-board-new-task] input")) as HTMLInputElement).value).toBe("");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps the text and offers a retry when adding fails", async () => {
    server.taskFails = true;
    await mount(); await settle();
    await click(buttonNamed("New task"));
    await type($("[data-board-new-task] input") as HTMLInputElement, "Write the brief");
    await click(buttonNamed("Add task")); await settle();
    expect((($("[data-board-new-task] input")) as HTMLInputElement).value).toBe("Write the brief");
    expect($("[data-board-new-task] [role=alert]")!.textContent).toContain("Couldn't add the task. Try again.");
    expect(buttonNamed("Try again")).not.toBeNull();
  });

  it("shows one line and a New task button when nothing is on the Board", async () => {
    server.cards = [];
    await mount(); await settle();
    expect($("[data-board-empty]")!.textContent).toContain("Work you hand to bots shows up here.");
    expect($("[data-board-column]")).toBeNull();
    expect([...document.querySelectorAll("button")].filter((one) => one.textContent?.includes("New task"))).toHaveLength(1);
  });

  it("filters by bot", async () => {
    await mount(); await settle();
    await click(buttonNamed("Show work for"));
    await click([...document.querySelectorAll<HTMLElement>("[role=menuitemradio]")].find((one) => one.textContent === "Cleo")!);
    expect([...document.querySelectorAll("[data-board-card]")].map((one) => (one as HTMLElement).dataset.boardCard).sort()).toEqual(["thread:w2"]);
  });

  it("offers a retry when the Board cannot load", async () => {
    server.loadFails = true;
    await mount(); await settle();
    expect($("[role=alert]")!.textContent).toContain("Couldn't load the Board.");
    server.loadFails = false;
    await click(buttonNamed("Try again")); await settle();
    expect($("[data-board-column]")).not.toBeNull();
  });
});

describe("the Board on a narrow window", () => {
  it("shows one column at a time behind tabs with counts that arrow keys move through", async () => {
    media(true);
    await mount(); await settle();
    const tabs = [...document.querySelectorAll<HTMLElement>("[role=tab]")];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["To do1", "Working3", "Needs you1", "Done1"]);
    expect($("[role=tablist]")).not.toBeNull();
    expect(document.querySelectorAll("[data-board-column]")).toHaveLength(1);
    expect($("[role=tab][aria-selected=true]")!.id).toBe("board-tab-needs-you");
    await key($("[role=tab][aria-selected=true]")!, "ArrowRight");
    expect($("[role=tab][aria-selected=true]")!.id).toBe("board-tab-done");
    await key($("[role=tab][aria-selected=true]")!, "ArrowLeft");
    await key($("[role=tab][aria-selected=true]")!, "ArrowLeft");
    expect($("[role=tab][aria-selected=true]")!.id).toBe("board-tab-working");
    expect($("[data-board-column=working]")!.querySelectorAll("[data-board-card]")).toHaveLength(3);
  });
});
