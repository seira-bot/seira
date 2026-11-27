// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), request: vi.fn() }));
vi.mock("@/state/store-select", () => ({
  useStoreSelector: (select: (state: unknown) => unknown) => select({ bots: [] }),
  useStoreDispatch: () => fixture.dispatch,
}));
vi.mock("@/state/todos", () => ({ useTodos: () => ({ todos: [], picker: null }), deleteTodo: vi.fn(), restoreTodo: vi.fn() }));
vi.mock("@/lib/board-focus", () => ({ requestBoardCard: fixture.request }));

import { RichMessageRow, UserLineNote, richRowKind } from "./RichMessageRow";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.dispatch.mockClear(); fixture.request.mockClear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("todo lines in the chat", () => {
  it("draws a bot line with a todo batch as a card row", () => {
    expect(richRowKind({ id: "m", role: "bot", kind: "text", at: 0, text: "Added", todoBatch: { todoIds: ["a"] } } as Message)).toBe("widget");
    expect(richRowKind({ id: "m", role: "bot", kind: "text", at: 0, text: "Added" } as Message)).toBe("text");
  });

  it("renders the card for that line", async () => {
    const message = { id: "m", role: "bot", kind: "text", at: 0, text: "Added", todoBatch: { todoIds: ["a", "b"] } } as Message;
    await act(async () => root.render(createElement(RichMessageRow, { botId: "b", botName: "Bot", threadId: "t", message })));
    expect(container.querySelector("[data-todo-batch]")?.textContent).toContain("Added 2 todos");
  });

  it("labels a person's line that a todo started and opens that todo", async () => {
    const message = { id: "m", role: "user", kind: "text", at: 0, text: "Do it", fromTodo: "todo-7" } as Message;
    await act(async () => root.render(createElement(UserLineNote, { message })));
    const label = container.querySelector<HTMLButtonElement>("[data-from-todo]")!;
    expect(label.textContent).toBe("From a todo");
    await act(async () => label.click());
    expect(fixture.request).toHaveBeenCalledWith("todo:todo-7");
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showBoard" });
  });
});
