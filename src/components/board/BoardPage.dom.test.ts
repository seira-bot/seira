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
  todos: [] as unknown[],
  picker: "cleo" as string | null,
  todoFails: false,
}));
const toasts = vi.hoisted(() => ({ list: [] as Array<{ text: string; actions?: Array<{ label: string; run: () => void }> }> }));
vi.mock("@/lib/power", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/power")>()),
  showToast: (text: string, options?: { actions?: Array<{ label: string; run: () => void }> }) => { toasts.list.push({ text, actions: options?.actions }); },
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/lib/live-events", () => ({ listenLiveFrames: () => () => {} }));
vi.mock("@/state/api", () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    server.calls.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (path === "/api/board") { if (server.loadFails) throw new Error("down"); return { cards: server.cards }; }
    if (path === "/api/board/close") { if (server.closeFails) throw new Error("down"); return { ok: true }; }
    if (path === "/api/auth/session") return {};
    if (path === "/api/todos" && !init?.method) return { todos: server.todos, picker: server.picker };
    if (path === "/api/todos" && init?.method === "POST") { if (server.todoFails) throw new Error("down"); return { todos: [{ id: "t-new", title: "x", status: "open", start: { kind: "free" }, rank: 9, madeBy: { kind: "person", name: "Rama" }, attempts: 0, depth: 0, createdAt: 1, updatedAt: 1 }] }; }
    if (path === "/api/todos/picker") return { ok: true };
    if (path.startsWith("/api/todos/") && init?.method === "PATCH") return { todo: server.todos.find((one) => (one as { id: string }).id === path.split("/").pop()) ?? {} };
    if (path.startsWith("/api/todos/")) return { ok: true };
    if (path === "/api/inbox") return inboxFixture.view();
    return {};
  }),
  ApiError: class extends Error {},
}));
const inboxFixture = vi.hoisted(() => ({ view: () => null as unknown }));

import { initialState, StoreContext, type AppState, type Bot } from "@/state/store";
import { resetBoardForTest, setBoardFilter } from "@/state/board";
import { resetTodosForTest } from "@/state/todos";
import { clearBoardCardRequest, requestBoardCard } from "@/lib/board-focus";
import { closeInbox, setInboxView } from "@/state/inbox";
import { inboxView, questionRow } from "@/testing/inbox-fixture";
import { BoardPage } from "./BoardPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bot = (id: string, name: string) => ({ id, name, color: "blue", threadId: `${id}-main`, tasks: [] }) as unknown as Bot;
const BOTS = [bot("scout", "Scout"), bot("cleo", "Cleo")];
const card = (id: string, patch: Partial<BoardCard> = {}): BoardCard => ({
  id, kind: "thread", column: "working", state: "running", title: `Title ${id}`, botId: "scout", threadId: `th-${id}`, createdAt: 1, updatedAt: Date.now(), ...patch,
});
const todo = (id: string, patch: Record<string, unknown> = {}) => ({
  id, title: `Todo ${id}`, status: "queued", start: { kind: "free" }, rank: 1, madeBy: { kind: "person", name: "Rama" }, attempts: 0, depth: 0, createdAt: 1, updatedAt: 1, botId: "scout", ...patch,
});
const todoCard = (id: string, patch: Partial<BoardCard> = {}): BoardCard => card(`todo:${id}`, { kind: "todo", column: "todo", state: "queued", title: `Todo ${id}`, todoId: id, group: "next", place: 1, threadId: undefined, ...patch });
const TODOS = [todo("a"), todo("b", { rank: 2 }), todo("o", { botId: undefined, status: "open" })];
const TODO_CARDS = [
  todoCard("a"),
  todoCard("b", { place: 2 }),
  todoCard("o", { state: "open", group: "open", botId: "", place: undefined }),
];
const CARDS = [
  card("thread:q", { column: "todo", state: "queued", group: "next" }),
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
  server.calls.length = 0; server.cards = CARDS; server.todos = []; server.picker = "cleo"; server.todoFails = false; toasts.list.length = 0; server.loadFails = false; server.taskFails = false; server.closeFails = false;
  inboxFixture.view = () => inboxView([questionRow]);
  dispatch.mockClear();
  resetBoardForTest();
  resetTodosForTest();
  clearBoardCardRequest();
  try { localStorage.clear(); } catch { /* none */ }
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
  it("shows four columns with a heading and no count", async () => {
    await mount(); await settle();
    expect([...document.querySelectorAll("h2")].map((h) => h.textContent)).toEqual(["To do", "Working", "Needs you", "Done"]);
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

  it("shows one line and a New todo button when nothing is on the Board", async () => {
    server.cards = [];
    await mount(); await settle();
    expect($("[data-board-empty]")!.textContent).toContain("Work you hand to bots shows up here.");
    expect($("[data-board-column]")).toBeNull();
    expect([...document.querySelectorAll("button")].filter((one) => one.textContent?.includes("New todo"))).toHaveLength(1);
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


describe("the Board with todos", () => {
  beforeEach(() => { server.todos = TODOS; server.cards = [...CARDS, ...TODO_CARDS]; });

  it("groups To do into Open and Up next, with a line under each todo", async () => {
    await mount(); await settle();
    const groups = [...document.querySelectorAll<HTMLElement>("[data-board-column=todo] [data-board-group]")].map((one) => one.dataset.boardGroup);
    expect(groups).toEqual(["open", "next"]);
    expect($("[data-board-card='todo:o']")!.textContent).toContain("Cleo is picking a bot…");
    expect($("[data-board-card='todo:b']")!.textContent).toContain("Up next · 2nd in line");
    expect($("[data-board-column=todo] h3")!.textContent).toBe("Open");
  });

  it("shows who picks bots and changes it from the picker menu", async () => {
    await mount(); await settle();
    const pill = $("[data-ui='board.picker'] button, button[data-ui='board.picker']") ?? buttonNamed("Cleo picks bots");
    expect(pill!.textContent).toContain("Cleo picks bots");
    await click(pill);
    const rows = [...document.querySelectorAll<HTMLElement>("[role=menuitemradio]")];
    expect(rows.map((one) => one.textContent).join("|")).toContain("Nobody");
    await click(rows.find((one) => one.textContent?.includes("Nobody"))!); await settle();
    expect(server.calls.find((call) => call.path === "/api/todos/picker")?.body).toEqual({ botId: null });
  });

  it("adds a todo from the inline form, says so, and Undo deletes it", async () => {
    await mount(); await settle();
    await click(buttonNamed("New todo"));
    const form = $("[data-board-new-todo]")!;
    await type(form.querySelector<HTMLInputElement>("input[type=text]")!, "Write the brief");
    await click(buttonNamed("Add todo")); await settle();
    expect(server.calls.find((call) => call.path === "/api/todos" && call.body)?.body).toMatchObject({ todos: [{ title: "Write the brief" }] });
    expect($("[data-board-new-todo]")).toBeNull();
    const toast = toasts.list.at(-1)!;
    expect(toast.text).toBe("Todo added.");
    await act(async () => { toast.actions![0]!.run(); }); await settle();
    expect(toast.actions![0]!.label).toBe("Undo");
    expect(server.calls.some((call) => call.path === "/api/todos/t-new")).toBe(true);
  });

  it("keeps the text and offers a retry when adding fails", async () => {
    server.todoFails = true;
    await mount(); await settle();
    await click(buttonNamed("New todo"));
    const input = $("[data-board-new-todo] input[type=text]") as HTMLInputElement;
    await type(input, "Write the brief");
    await click(buttonNamed("Add todo")); await settle();
    expect(($("[data-board-new-todo] input[type=text]") as HTMLInputElement).value).toBe("Write the brief");
    expect($("[data-board-new-todo] [role=alert]")!.textContent).toContain("Couldn't add the todo. Try again.");
  });

  it("opens a todo in its own panel with Start, Delete and a delete Undo", async () => {
    await mount(); await settle();
    await click($("[data-board-card='todo:a']")); await settle();
    const panel = $("[data-todo-panel='a']")!;
    expect(panel).not.toBeNull();
    expect(panel.textContent).toContain("Made by");
    expect(buttonNamed("Start now")).not.toBeNull();
    await click(buttonNamed("Delete")); await settle();
    expect(server.calls.some((call) => call.path === "/api/todos/a")).toBe(true);
    const toast = toasts.list.at(-1)!;
    expect(toast.text).toBe("Todo deleted.");
    await act(async () => { toast.actions![0]!.run(); }); await settle();
    expect(server.calls.some((call) => call.path === "/api/todos/a/restore")).toBe(true);
  });

  it("opens the card another page asked for", async () => {
    requestBoardCard("todo:b");
    await mount(); await settle();
    expect($("[data-todo-panel='b']")).not.toBeNull();
  });

  it("remembers the Columns or By bot choice", async () => {
    await mount(); await settle();
    await click($("[data-board-view=bybot]"));
    expect($("[data-board-bot-row=scout]")).not.toBeNull();
    expect(localStorage.getItem("seira.board.view")).toBe("bybot");
    act(() => root.unmount());
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await mount(); await settle();
    expect($("[data-board-bot-row=scout]")).not.toBeNull();
  });

  describe("By bot", () => {
    beforeEach(async () => {
      try { localStorage.setItem("seira.board.view", "bybot"); } catch { /* none */ }
      await mount(); await settle();
    });

    it("shows one row per bot, with Up next numbered and the starts label", async () => {
      expect($("[data-board-bot-row=scout]")!.querySelector("[data-board-lane=next]")!.textContent).toContain("Todo a");
      expect($("[data-board-bot-row=scout] [data-board-starts]")!.textContent).toBe("Starts on its own");
      expect($("[data-board-open-band]")!.textContent).toContain("Todo o");
    });

    it("moves an open todo to a bot by drag, and Undo makes it open again", async () => {
      const data = new Map<string, string>();
      const transfer = { types: ["application/x-seira-todo"], setData: (k: string, v: string) => { data.set(k, v); }, getData: (k: string) => data.get(k) ?? "", effectAllowed: "", dropEffect: "" };
      const fire = (el: Element, type: string) => act(async () => { const e = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(e, "dataTransfer", { value: transfer }); el.dispatchEvent(e); });
      await fire($("[data-board-card='todo:o']")!.parentElement!, "dragstart");
      await fire($("[data-board-bot-row=cleo]")!, "dragover");
      await fire($("[data-board-bot-row=cleo]")!, "drop"); await settle();
      const patch = server.calls.find((call) => call.path === "/api/todos/o" && call.body);
      expect(patch?.body).toMatchObject({ botId: "cleo" });
      const toast = toasts.list.at(-1)!;
      expect(toast.text).toBe("Cleo got “Todo o”.");
      await act(async () => { toast.actions![0]!.run(); }); await settle();
      expect(server.calls.filter((call) => call.path === "/api/todos/o" && call.body).at(-1)?.body).toEqual({ botId: null });
    });

    it("moves a todo down in line with Alt+ArrowDown, and Undo puts it back", async () => {
      const first = $("[data-board-card='todo:a']")!;
      await act(async () => { first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true })); }); await settle();
      const patch = server.calls.find((call) => call.path === "/api/todos/a" && call.body);
      expect(patch?.body).toMatchObject({ botId: "scout", beforeId: null });
      const toast = toasts.list.at(-1)!;
      await act(async () => { toast.actions![0]!.run(); }); await settle();
      expect(server.calls.filter((call) => call.path === "/api/todos/a" && call.body).at(-1)?.body).toEqual({ botId: "scout", beforeId: "b" });
    });
  });
});
