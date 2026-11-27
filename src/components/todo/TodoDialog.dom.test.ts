// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { todoOf } from "./todo-fixtures";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), addTodos: vi.fn(), toast: vi.fn(), deleteTodo: vi.fn(async () => {}), request: vi.fn() }));
vi.mock("@/state/store-select", () => ({
  useStoreSelector: (select: (state: unknown) => unknown) => select({ bots: [{ id: "felix", name: "Felix", color: "blue" }, { id: "hidden", name: "Hidden", hidden: true }] }),
  useStoreDispatch: () => fixture.dispatch,
}));
vi.mock("@/state/todos", () => ({ useTodos: () => ({ todos: [], picker: "felix" }), addTodos: fixture.addTodos, deleteTodo: fixture.deleteTodo }));
vi.mock("@/lib/power", () => ({ showToast: fixture.toast }));
vi.mock("@/lib/board-focus", () => ({ requestBoardCard: fixture.request }));
vi.mock("../Select", () => ({ Select: (props: Record<string, unknown>) => createElement("select", props) }));

import { closeTodoDialog } from "./todo-dialog-state";
import { todoMenuItems } from "./todo-menu";
import { TodoDialogHost } from "./TodoDialog";

let container: HTMLDivElement, root: Root;
const dialog = () => container.querySelector<HTMLElement>("[data-todo-dialog]");
const field = <T extends HTMLElement>(label: string) => container.querySelector<T>(`[aria-label="${label}"]`)!;
const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of [fixture.dispatch, fixture.addTodos, fixture.toast, fixture.deleteTodo, fixture.request]) mock.mockClear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(TodoDialogHost)));
});
afterEach(async () => { await act(async () => closeTodoDialog()); await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const open = async (selection?: string, source: Parameters<typeof todoMenuItems>[2] = { threadId: "t1", botId: "felix", who: "Felix", at: new Date(2026, 10, 27, 10, 41).getTime(), user: false }) => {
  const items = todoMenuItems("Check the competitors’ December prices\nStart with the three biggest.", "m1", source);
  await act(async () => items.find((item) => item.key === (selection ? "todo-selection" : "todo-message"))!.onSelect(selection));
};

describe("the todo dialog", () => {
  it("offers the two rows and builds the selection row for selected text only", () => {
    const items = todoMenuItems("text", "m1", { threadId: "t1", at: 0, user: true });
    expect(items.map((item) => [item.key, item.label, item.selectionOnly ?? false])).toEqual([
      ["todo-selection", "Make a todo from selection", true], ["todo-message", "Make a todo from message", false],
    ]);
    expect(todoMenuItems("text", "optimistic-1", { threadId: "t1", at: 0, user: true })).toEqual([]);
    expect(todoMenuItems("text", "m1", undefined)).toEqual([]);
  });

  it("fills the form from the message, names the source and starts with the chat's bot", async () => {
    await open();
    expect(dialog()?.textContent).toContain("New todo");
    expect(field<HTMLInputElement>("Todo").value).toBe("Check the competitors’ December prices");
    expect(field<HTMLTextAreaElement>("Note").value).toBe("Start with the three biggest.");
    expect(container.querySelector<HTMLSelectElement>("[data-todo-bot]")!.value).toBe("felix");
    expect(container.querySelector("[data-todo-source]")?.textContent).toMatch(/^From Felix · .+ · “Check the competitors’ December prices Start with the three biggest\.”$/);
    expect(container.querySelector("[data-todo-bot]")!.textContent).not.toContain("Hidden");
  });

  it("uses the selection as the title and quote", async () => {
    await open("December prices");
    expect(field<HTMLInputElement>("Todo").value).toBe("December prices");
    expect(container.querySelector("[data-todo-source]")?.textContent).toContain("“December prices”");
  });

  it("starts with Any bot in a room and names the person in their own line", async () => {
    await open(undefined, { threadId: "t2", groupId: "g1", at: 0, user: true });
    expect(container.querySelector<HTMLSelectElement>("[data-todo-bot]")!.value).toBe("");
    expect(container.querySelector("[data-todo-source]")?.textContent).toMatch(/^From you · /);
  });

  it("adds the todo with its source, closes, and offers Undo and Open board", async () => {
    fixture.addTodos.mockResolvedValue([todoOf("new", { botId: "felix" })]);
    await open("December prices");
    await act(async () => button("Add todo").click());
    expect(fixture.addTodos).toHaveBeenCalledTimes(1);
    expect(fixture.addTodos.mock.calls[0]![0]).toEqual([{
      title: "December prices", botId: "felix", start: { kind: "free" },
      source: { threadId: "t1", messageId: "m1", botId: "felix", quote: "December prices" },
    }]);
    expect(dialog()).toBeNull();
    const [text, options] = fixture.toast.mock.calls[0]!;
    expect(text).toBe("Todo added for Felix.");
    expect(options.actions.map((action: { label: string }) => action.label)).toEqual(["Undo", "Open board"]);
    options.actions[0].run();
    expect(fixture.deleteTodo).toHaveBeenCalledWith("new");
    options.actions[1].run();
    expect(fixture.request).toHaveBeenCalledWith("todo:new");
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showBoard" });
  });

  it("sends the room as the source in a room", async () => {
    fixture.addTodos.mockResolvedValue([todoOf("new")]);
    await open(undefined, { threadId: "t2", groupId: "g1", who: "Rhea", at: 0, user: false });
    await act(async () => button("Add todo").click());
    expect(fixture.addTodos.mock.calls[0]![0][0].source).toMatchObject({ threadId: "t2", messageId: "m1", groupId: "g1" });
    expect(fixture.addTodos.mock.calls[0]![0][0].source.botId).toBeUndefined();
    expect(fixture.toast.mock.calls[0]![0]).toBe("Todo added.");
  });

  it("keeps the dialog and says so in a plain sentence when adding fails", async () => {
    fixture.addTodos.mockRejectedValue(new Error("HTTP 500 /api/todos"));
    await open("December prices");
    await act(async () => button("Add todo").click());
    expect(dialog()).not.toBeNull();
    expect(container.querySelector("[role=alert]")?.textContent).toBe("The todo was not added. Try again.");
    expect(fixture.toast).not.toHaveBeenCalled();
  });

  it("disables Add todo while the title is empty, and Cancel closes", async () => {
    await open("December prices");
    await type(field<HTMLInputElement>("Todo"), "   ");
    expect(button("Add todo").hasAttribute("disabled")).toBe(true);
    await act(async () => button("Cancel").click());
    expect(dialog()).toBeNull();
  });
});
