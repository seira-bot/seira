// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { BoardCard } from "../../../shared/board";

const server = vi.hoisted(() => ({ cards: [] as unknown[], requested: [] as string[] }));
vi.mock("@/lib/board-focus", () => ({ requestBoardCard: (id: string) => { server.requested.push(id); } }));
vi.mock("@/lib/live-events", () => ({ listenLiveFrames: () => () => {} }));
vi.mock("@/state/api", () => ({
  api: vi.fn(async (path: string) => (path === "/api/board" ? { cards: server.cards } : path === "/api/todos" ? { todos: [], picker: null } : {})),
  ApiError: class extends Error {},
}));

import { initialState, StoreContext, type AppState, type Bot } from "@/state/store";
import { resetBoardForTest } from "@/state/board";
import { resetTodosForTest } from "@/state/todos";
import { BotTodos } from "./BotTodos";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bot = { id: "rhea", name: "Rhea", color: "red", threadId: "rhea-main", tasks: [] } as unknown as Bot;
const card = (id: string, patch: Partial<BoardCard> = {}): BoardCard => ({
  id: `todo:${id}`, kind: "todo", column: "todo", state: "queued", title: `Todo ${id}`, botId: "rhea", todoId: id, group: "next", place: 1, createdAt: 1, updatedAt: 1, ...patch,
});
let root: Root;
const dispatch = vi.fn();
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const mount = () => act(async () => {
  root.render(createElement(StoreContext.Provider, { value: { state: { ...initialState, bots: [bot], groups: [] } as AppState, dispatch } as never }, createElement(BotTodos, { bot })));
});

beforeEach(() => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  resetBoardForTest(); resetTodosForTest(); dispatch.mockClear();
  server.cards = [
    card("n", { column: "working", state: "running", group: undefined, place: undefined }),
    card("u", {}),
    card("l", { group: "scheduled", place: undefined }),
    card("x", { botId: "other" }),
  ];
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; });

it("lists the bot's todos in Now, Up next and Later, and says when a lane is empty", async () => {
  await mount(); await settle();
  const lane = (name: string) => document.querySelector(`[data-bot-todos-lane='${name}']`)!.textContent;
  expect(lane("Now")).toContain("Todo n");
  expect(lane("Up next")).toContain("Todo u");
  expect(lane("Later")).toContain("Todo l");
  expect(document.body.textContent).not.toContain("Todo x");
  server.cards = [];
  act(() => root.unmount()); resetBoardForTest();
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await mount(); await settle();
  expect(document.body.textContent).toContain("Nothing in line");
});

it("opens a todo on the Board and opens the Board", async () => {
  await mount(); await settle();
  await act(async () => { document.querySelector<HTMLElement>("[data-bot-todo=u]")!.click(); });
  expect(dispatch).toHaveBeenCalledWith({ type: "showBoard" });
  expect(server.requested).toEqual(["todo:u"]);
  dispatch.mockClear();
  await act(async () => { document.querySelector<HTMLElement>("[data-panel-action=open-board]")!.click(); });
  expect(dispatch).toHaveBeenCalledWith({ type: "showBoard" });
});
