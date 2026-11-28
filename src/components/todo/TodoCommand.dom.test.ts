// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";
import { todoOf } from "./todo-fixtures";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), addTodos: vi.fn(), toast: vi.fn(), deleteTodo: vi.fn(async () => {}) }));
vi.mock("@/state/store-select", () => ({ useStoreDispatch: () => fixture.dispatch }));
vi.mock("@/state/todos", () => ({ addTodos: fixture.addTodos, deleteTodo: fixture.deleteTodo }));
vi.mock("@/lib/power", () => ({ showToast: fixture.toast }));

import { todoSlashCommand, useTodoCommand } from "./TodoCommand";

const bots = [{ id: "felix", name: "Felix" }, { id: "rhea", name: "Rhea" }, { id: "gone", name: "Gone", hidden: true }] as unknown as Bot[];
let container: HTMLDivElement, root: Root, ran: boolean | null, done: ReturnType<typeof vi.fn>;

function Probe({ text, botId, groupId }: { text: string; botId?: string; groupId?: string }) {
  const todo = useTodoCommand({ text, bots, botId, groupId, threadId: "t1", onDone: done as () => void });
  return createElement("div", null, todo.preview, createElement("button", { "data-run": "", onClick: () => { ran = todo.run(); } }));
}
const draw = async (props: { text: string; botId?: string; groupId?: string }) => { await act(async () => root.render(createElement(Probe, props))); };
const preview = () => container.querySelector("[data-todo-command-preview]");
const run = async () => { await act(async () => container.querySelector<HTMLButtonElement>("[data-run]")!.click()); await act(async () => {}); };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of [fixture.dispatch, fixture.addTodos, fixture.toast, fixture.deleteTodo]) mock.mockClear();
  ran = null; done = vi.fn();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("/todo in the composer", () => {
  it("is a built-in command in the / list", () => {
    expect(todoSlashCommand()).toMatchObject({ kind: "command", id: "todo", label: "/todo" });
  });

  it("shows no preview and sends normal text on", async () => {
    await draw({ text: "hello there" });
    expect(preview()).toBeNull();
    await run();
    expect(ran).toBe(false);
    expect(fixture.addTodos).not.toHaveBeenCalled();
  });

  it("shows the title, the bot and the time while the text starts with /todo", async () => {
    await draw({ text: "/todo Check the competitors’ December prices @Felix tomorrow", botId: "rhea" });
    expect(preview()?.textContent).toMatch(/^Check the competitors’ December prices · For Felix · Tomorrow, .+Add todo$/);
  });

  it("uses the chat's bot, and Any bot in a room", async () => {
    await draw({ text: "/todo Write the notes", botId: "rhea" });
    expect(preview()?.textContent).toContain("For Rhea · When free");
    await draw({ text: "/todo Write the notes", groupId: "g1" });
    expect(preview()?.textContent).toContain("For Any bot · When free");
  });

  it("shows no preview while the title is empty, and still keeps the text from the chat", async () => {
    await draw({ text: "/todo " });
    expect(preview()).toBeNull();
    await run();
    expect(ran).toBe(true);
    expect(fixture.addTodos).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });

  it("adds the todo with the chat as its source, clears the composer and sends no message", async () => {
    fixture.addTodos.mockResolvedValue([todoOf("new", { botId: "felix" })]);
    await draw({ text: "/todo Check prices @felix daily 08:30", botId: "rhea" });
    await run();
    expect(ran).toBe(true);
    expect(fixture.addTodos.mock.calls[0]![0]).toEqual([{
      title: "Check prices", botId: "felix", start: { kind: "free" }, repeat: { time: "08:30", weekdays: [] },
      source: { threadId: "t1", botId: "rhea" },
    }]);
    expect(done).toHaveBeenCalledTimes(1);
    expect(fixture.toast.mock.calls[0]![0]).toMatch(/^Todo added for Felix/);
    expect(fixture.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send" }));
  });

  it("puts the room in the source in a room and leaves the bot out", async () => {
    fixture.addTodos.mockResolvedValue([todoOf("new")]);
    await draw({ text: "/todo Plan the week", groupId: "g1" });
    await run();
    expect(fixture.addTodos.mock.calls[0]![0][0]).toEqual({ title: "Plan the week", start: { kind: "free" }, source: { threadId: "t1", groupId: "g1" } });
  });

  it("does not name a hidden bot", async () => {
    await draw({ text: "/todo Ask @Gone to wait" });
    expect(preview()?.textContent).toContain("Ask @Gone to wait · For Any bot");
  });

  it("adds from the Add todo button of the preview", async () => {
    fixture.addTodos.mockResolvedValue([todoOf("new")]);
    await draw({ text: "/todo Plan the week", botId: "rhea" });
    await act(async () => { [...container.querySelectorAll("button")].find((item) => item.textContent === "Add todo")!.click(); });
    await act(async () => {});
    expect(fixture.addTodos).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("keeps the text and says so when adding fails", async () => {
    fixture.addTodos.mockRejectedValue(new Error("HTTP 500"));
    await draw({ text: "/todo Plan the week", botId: "rhea" });
    await run();
    expect(done).not.toHaveBeenCalled();
    expect(fixture.toast.mock.calls[0]![0]).toBe("The todo was not added. Try again.");
  });
});
