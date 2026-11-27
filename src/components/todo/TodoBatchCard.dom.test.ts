// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Todo } from "../../../shared/todo";
import type { Message } from "@/state/store";
import { todoOf } from "./todo-fixtures";

const fixture = vi.hoisted(() => ({
  todos: [] as Todo[], dispatch: vi.fn(), request: vi.fn(),
  deleteTodo: vi.fn(async (id: string) => { fixture.todos = fixture.todos.filter((todo) => todo.id !== id); }),
  restoreTodo: vi.fn(async () => ({})),
}));
vi.mock("@/state/store-select", () => ({
  useStoreSelector: (select: (state: unknown) => unknown) => select({ bots: [{ id: "felix", name: "Felix", color: "blue" }] }),
  useStoreDispatch: () => fixture.dispatch,
}));
vi.mock("@/state/todos", () => ({ useTodos: () => ({ todos: fixture.todos, picker: null }), deleteTodo: fixture.deleteTodo, restoreTodo: fixture.restoreTodo }));
vi.mock("@/lib/board-focus", () => ({ requestBoardCard: fixture.request }));
vi.mock("../Avatar", () => ({ BotAvatar: () => null }));
vi.mock("../AskCard", () => ({ ASK_QUIET_BUTTON: "quiet" }));

import { TodoBatchCard } from "./TodoBatchCard";

let container: HTMLDivElement, root: Root, serial = 0;
const batch = (ids: string[]): Message => ({ id: `batch-${++serial}`, role: "bot", kind: "text", at: 0, text: "Added todos", todoBatch: { todoIds: ids } } as Message);
const draw = async (message: Message) => { await act(async () => root.render(createElement(TodoBatchCard, { message }))); };
const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label);
const click = async (label: string) => { await act(async () => { button(label)!.click(); }); await act(async () => {}); };
const rows = () => [...container.querySelectorAll<HTMLElement>("[data-todo-row]")];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.todos = []; fixture.dispatch.mockClear(); fixture.request.mockClear(); fixture.deleteTodo.mockClear(); fixture.restoreTodo.mockClear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("the Added N todos card", () => {
  it("counts the todos and shows bot, reason and time on each row", async () => {
    fixture.todos = [
      todoOf("a", { title: "Check prices", botId: "felix", pickedBy: { botId: "felix", reason: "knows the market" } }),
      todoOf("b", { title: "Write notes" }),
    ];
    await draw(batch(["a", "b"]));
    expect(container.textContent).toContain("Added 2 todos");
    expect(rows()[0]!.textContent).toContain("Check prices");
    expect(rows()[0]!.textContent).toContain("Felix · knows the market");
    expect(rows()[0]!.textContent).toContain("When free");
    expect(rows()[1]!.textContent).toContain("Any bot");
  });

  it("says Added 1 todo for one", async () => {
    fixture.todos = [todoOf("a")];
    await draw(batch(["a"]));
    expect(container.textContent).toContain("Added 1 todo");
    expect(container.textContent).not.toContain("Added 1 todos");
  });

  it("mutes a row whose todo is gone", async () => {
    fixture.todos = [todoOf("a")];
    await draw(batch(["a", "gone"]));
    expect(rows()[1]!.getAttribute("data-state")).toBe("removed");
    expect(rows()[1]!.textContent).toBe("Removed");
  });

  it("opens the first todo on the Board", async () => {
    fixture.todos = [todoOf("a"), todoOf("b")];
    await draw(batch(["a", "b"]));
    await click("Open board");
    expect(fixture.request).toHaveBeenCalledWith("todo:a");
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showBoard" });
  });

  it("removes only the todos that are still open or queued, and brings them back", async () => {
    fixture.todos = [todoOf("a", { status: "queued" }), todoOf("b", { status: "open" }), todoOf("c", { status: "working" })];
    await draw(batch(["a", "b", "c"]));
    await click("Undo");
    expect(fixture.deleteTodo.mock.calls.map((call) => (call as string[])[0])).toEqual(["a", "b"]);
    expect(container.querySelector("[data-todo-batch-undone]")?.textContent).toBe("You removed these 2 todos.");
    expect(button("Undo")).toBeUndefined();
    await click("Bring them back");
    expect(fixture.restoreTodo.mock.calls.map((call) => (call as string[])[0])).toEqual(["a", "b"]);
    expect(container.querySelector("[data-todo-bring-back]")).toBeNull();
  });

  it("offers no Undo when every todo started", async () => {
    fixture.todos = [todoOf("a", { status: "working" }), todoOf("b", { status: "done" })];
    await draw(batch(["a", "b"]));
    expect(button("Undo")).toBeUndefined();
  });

  it("keeps the undone state when the card shows again", async () => {
    fixture.todos = [todoOf("a")];
    const message = batch(["a"]);
    await draw(message);
    await click("Undo");
    await act(async () => root.unmount());
    root = createRoot(container);
    await draw(message);
    expect(container.querySelector("[data-todo-batch-undone]")?.textContent).toBe("You removed this todo.");
    expect(button("Bring it back")).toBeTruthy();
  });

  it("shows a plain sentence when a todo cannot be removed", async () => {
    fixture.todos = [todoOf("a")];
    fixture.deleteTodo.mockRejectedValueOnce(new Error("boom"));
    await draw(batch(["a"]));
    await click("Undo");
    expect(container.querySelector("[role=alert]")?.textContent).toBe("Some todos could not be changed. Try again.");
    expect(container.textContent).not.toContain("boom");
  });
});
