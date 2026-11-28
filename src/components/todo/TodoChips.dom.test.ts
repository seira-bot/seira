// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { todoOf } from "./todo-fixtures";

const fixture = vi.hoisted(() => ({ todos: [] as unknown[], picker: null as string | null, dispatch: vi.fn(), request: vi.fn() }));
vi.mock("@/state/store-select", () => ({
  useStoreSelector: (select: (state: unknown) => unknown) => select({ bots: [{ id: "felix", name: "Felix", color: "blue" }, { id: "rhea", name: "Rhea", color: "green" }] }),
  useStoreDispatch: () => fixture.dispatch,
}));
vi.mock("@/state/todos", () => ({ useTodos: () => ({ todos: fixture.todos, picker: fixture.picker }) }));
vi.mock("@/lib/board-focus", () => ({ requestBoardCard: fixture.request }));
vi.mock("../Avatar", () => ({ BotAvatar: () => null }));

import { TodoChips, useTodoChips } from "./TodoChips";

let container: HTMLDivElement, root: Root;
function Row({ messageId, end }: { messageId: string; end?: boolean }) {
  const chips = useTodoChips();
  return createElement(TodoChips, { messageId, chips, end });
}
const show = async (messageId = "m1") => { await act(async () => root.render(createElement(Row, { messageId }))); };
const chips = () => [...container.querySelectorAll<HTMLElement>("[data-todo-chip]")];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.todos = []; fixture.picker = "rhea"; fixture.dispatch.mockClear(); fixture.request.mockClear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("the todo chips under a message", () => {
  it("shows nothing for a message without todos", async () => {
    fixture.todos = [todoOf("a", { source: { threadId: "t", messageId: "other" } })];
    await show();
    expect(container.innerHTML).toBe("");
  });

  it("names the place and the bot of each todo, newest first", async () => {
    fixture.todos = [
      todoOf("a", { botId: "rhea", status: "queued", source: { threadId: "t", messageId: "m1" } }),
      todoOf("b", { botId: "felix", status: "working", source: { threadId: "t", messageId: "m1" } }),
    ];
    await show();
    expect(chips().map((chip) => chip.textContent)).toEqual(["Todo · Working for Felix", "Todo · Up next for Rhea"]);
  });

  it("says Open without a bot", async () => {
    fixture.todos = [todoOf("a", { status: "open", source: { threadId: "t", messageId: "m1" } })];
    await show();
    expect(chips().map((chip) => chip.textContent)).toEqual(["Todo · Open"]);
  });

  it("shows two chips and then \"and N more\"", async () => {
    fixture.todos = ["a", "b", "c", "d"].map((id) => todoOf(id, { botId: "rhea", source: { threadId: "t", messageId: "m1" } }));
    await show();
    expect(chips()).toHaveLength(2);
    expect(container.querySelector("[data-todo-chips-more]")?.textContent).toBe("and 2 more");
  });

  it("opens the todo on the Board", async () => {
    fixture.todos = [todoOf("a", { botId: "rhea", source: { threadId: "t", messageId: "m1" } })];
    await show();
    await act(async () => chips()[0]!.click());
    expect(fixture.request).toHaveBeenCalledWith("todo:a");
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showBoard" });
  });
});
