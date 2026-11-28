import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Lightbulb, Mail } from "lucide-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/state/store";
import { TaskSuggestionsCard, taskSuggestionIcon } from "./TaskSuggestionsCard";
import { richRowKind } from "./RichMessageRow";

const fixture = vi.hoisted(() => ({ values: [] as unknown[], index: 0, api: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = initial;
    return [fixture.values[index], (next: unknown) => { fixture.values[index] = typeof next === "function" ? (next as (v: unknown) => unknown)(fixture.values[index]) : next; }];
  },
}));
vi.mock("@/state/store", () => ({ api: fixture.api }));

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (value: ReactNode): Node[] => Children.toArray(value).flatMap((child) => (isValidElement(child) ? [child as Node, ...nodes((child as Node).props.children)] : []));

type Suggestion = NonNullable<Message["taskSuggestions"]>["suggestions"][number];
const open = (id: string, title: string, extra: Partial<Suggestion> = {}): Suggestion => ({ id, title, icon: "mail", state: "open", ...extra });
const line = (suggestions: Suggestion[], intro?: string): Message => ({
  id: "m1", role: "bot", kind: "text", at: 0, text: "Tasks", taskSuggestions: { ...(intro ? { intro } : {}), suggestions },
} as Message);

function render(of: Message, viewOnly?: boolean) {
  let tree: ReactNode = null;
  function Capture() { fixture.index = 0; tree = TaskSuggestionsCard({ botId: "b1", threadId: "t1", message: of, viewOnly }); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  const all = nodes(tree);
  const button = (label: string) => all.find((node) => node.type === "button" && node.props["aria-label"] === label);
  return { html, all, button };
}
const click = async (node: Node | undefined) => { (node!.props.onClick as () => void)(); await Promise.resolve(); await Promise.resolve(); };

beforeEach(() => {
  fixture.values = [];
  fixture.api.mockReset().mockResolvedValue({ ok: true });
});

describe("the tasks I could help with card", () => {
  it("draws one row per open task with icon, title, description, Hide and Start", () => {
    const view = render(line([open("s1", "Sort my email", { description: "Group the new mail" }), open("s2", "Plan my week", { icon: "calendar" })]));
    expect(view.html).toContain("Tasks I could help with:");
    expect(view.html).toContain("Sort my email");
    expect(view.html).toContain("Group the new mail");
    expect(view.html).toContain("Plan my week");
    expect(view.html).toContain("<svg");
    expect(view.button("Hide Sort my email")).toBeDefined();
    expect(view.button("Start Sort my email")).toBeDefined();
    expect(view.button("Start Plan my week")).toBeDefined();
    expect(richRowKind(line([open("s1", "x")]))).toBe("widget");
  });

  it("uses the bot's intro as the heading when present", () => {
    const view = render(line([open("s1", "Sort my email")], "Here is what I can do:"));
    expect(view.html).toContain("Here is what I can do:");
    expect(view.html).not.toContain("Tasks I could help with:");
  });

  it("draws the idea icon for a name it does not know", () => {
    expect(taskSuggestionIcon("rocket")).toBe(Lightbulb);
    expect(taskSuggestionIcon("toString")).toBe(Lightbulb);
    expect(taskSuggestionIcon("mail")).toBe(Mail);
  });

  it("sends exactly the thread, line, task and action on Start", async () => {
    const view = render(line([open("s1", "Sort my email")]));
    await click(view.button("Start Sort my email"));
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/b1/task-suggestions", {
      method: "POST",
      body: JSON.stringify({ threadId: "t1", messageId: "m1", suggestionId: "s1", action: "start" }),
    });
  });

  it("shows Hidden with Undo after Hide, and Undo sends show", async () => {
    const original = line([open("s1", "Sort my email"), open("s2", "Plan my week")]);
    fixture.api.mockResolvedValue({ ok: true, message: line([open("s1", "Sort my email", { state: "hidden" }), open("s2", "Plan my week")]) });
    await click(render(original).button("Hide Sort my email"));
    const hidden = render(original);
    expect(hidden.html).toContain("Hidden");
    expect(hidden.button("Start Sort my email")).toBeUndefined();
    expect(hidden.button("Start Plan my week")).toBeDefined();
    fixture.api.mockResolvedValue({ ok: true, message: line([open("s1", "Sort my email"), open("s2", "Plan my week")]) });
    await click(hidden.button("Show Sort my email again"));
    expect(JSON.parse((fixture.api.mock.calls[1]![1] as { body: string }).body)).toEqual({ threadId: "t1", messageId: "m1", suggestionId: "s1", action: "show" });
    const shown = render(original);
    expect(shown.html).not.toContain("Hidden");
    expect(shown.button("Start Sort my email")).toBeDefined();
  });

  it("shows a Started receipt and no buttons for a started task", () => {
    const view = render(line([open("s1", "Sort my email", { state: "started" })]));
    expect(view.html).toContain("Started");
    expect(view.html).toContain("Sort my email");
    expect(view.all.some((node) => node.type === "button")).toBe(false);
  });

  it("draws nothing for a hidden task after a reload, and no card when none is left", () => {
    const view = render(line([open("s1", "Sort my email", { state: "hidden" })]));
    expect(view.html).toBe("");
    const mixed = render(line([open("s1", "Sort my email", { state: "hidden" }), open("s2", "Plan my week")]));
    expect(mixed.html).not.toContain("Sort my email");
    expect(mixed.html).toContain("Plan my week");
  });

  it("keeps the buttons and shows an alert when the request fails", async () => {
    fixture.api.mockRejectedValue(new Error("Wait a moment, then try again."));
    const original = line([open("s1", "Sort my email")]);
    await click(render(original).button("Start Sort my email"));
    const after = render(original);
    expect(after.html).toContain('role="alert"');
    expect(after.html).toContain("Wait a moment, then try again.");
    expect(after.button("Start Sort my email")).toBeDefined();
    expect(after.button("Hide Sort my email")).toBeDefined();
  });

  it("falls back to the plain failure text, and takes the current line from a 409", async () => {
    const original = line([open("s1", "Sort my email")]);
    const current = line([open("s1", "Sort my email", { state: "started" })]);
    fixture.api.mockRejectedValue(Object.assign(new Error(""), { status: 409, body: { error: "x", message: current } }));
    await click(render(original).button("Start Sort my email"));
    const after = render(original);
    expect(after.html).toContain("That did not work. Try again.");
    expect(after.html).toContain("Started");
    expect(after.button("Start Sort my email")).toBeUndefined();
  });
});
