// @vitest-environment happy-dom
import { createElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { Message } from "@/state/store";

type Action = { type: string; [key: string]: unknown };
/** `appear` maps an action type to the elements the app draws after it, as attribute and value. */
const f = vi.hoisted(() => ({ advanced: true, dispatch: null as unknown as (action: Action) => void, appear: {} as Record<string, [string, string][]> }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => f.advanced, readAdvancedMode: () => f.advanced }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: {} }, dispatch: (action: Action) => f.dispatch(action) }), api: async () => ({}) }));
vi.mock("./onboarding/Spotlight", async () => {
  const { createElement: h } = await import("react");
  return { Spotlight: (props: { anchor: string; attr?: string; primary?: { label: string; onClick: () => void }; children: ReactNode }) =>
    h("div", { "data-spot": props.anchor, "data-spot-attr": props.attr ?? "tour" }, props.children, props.primary && h("button", { "data-spot-done": "", onClick: props.primary.onClick }, props.primary.label)) };
});

const { RichMessageRow, richRowKind } = await import("./RichMessageRow");

const row = (id: string, text = "The server's own words."): Message => ({ id: "m1", role: "bot", kind: "text", text, uiPlace: { id } }) as unknown as Message;

let host: HTMLDivElement;
let screen: HTMLDivElement;
let root: Root;
let actions: Action[];
let clicked: string[];

function draw(attr: string, value: string) {
  const el = document.createElement("button");
  el.setAttribute(`data-${attr}`, value);
  el.addEventListener("click", () => clicked.push(`${attr}:${value}`));
  screen.append(el);
}

beforeEach(() => {
  setLocale("en");
  f.advanced = true;
  f.appear = {};
  actions = [];
  clicked = [];
  f.dispatch = (action) => {
    actions.push(action);
    for (const [attr, value] of f.appear[action.type] ?? []) draw(attr, value);
  };
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) { return [{}] as unknown as DOMRectList; });
  host = document.createElement("div");
  screen = document.createElement("div");
  document.body.append(host, screen);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  screen.remove();
  vi.restoreAllMocks();
});

function show(message: Message) {
  flushSync(() => root.render(createElement(RichMessageRow, { botId: "kiwi", botName: "Kiwi", threadId: "t-kiwi", message })));
}
const openButton = () => host.querySelector<HTMLButtonElement>("[data-ui-place-open]");
const spot = () => host.querySelector<HTMLElement>("[data-spot]");

describe("a place card in chat", () => {
  it("is drawn as a card row, not as the bot's text", () => {
    expect(richRowKind(row("board.new-task"))).toBe("widget");
  });

  it("takes the label and the position from the UI map, not from the row text", () => {
    show(row("board.new-task", "LIES: click the red button"));
    const card = host.querySelector("[data-ui-place-card='board.new-task']")!;
    expect(card.textContent).toContain("New task");
    expect(card.querySelector("[data-ui-place-position]")!.textContent).toBe("top right of the Board page, a filled button");
    expect(host.textContent).not.toContain("LIES");
    expect(openButton()!.textContent).toBe("Open it");
  });

  it("shows no steps while the button is offered", () => {
    show(row("board.new-task"));
    expect(host.querySelector("[data-ui-place-steps]")).toBeNull();
  });

  it.each([
    ["board.new-task", "showBoard", ["ui", "board.new-task"]],
    ["automations.page", "showRoutines", ["tour", "automations-page"]],
    ["apps.search", "togglePlugins", ["ui", "apps.search"]],
  ] as const)("%s: opens its page, then spotlights the right element; the app never clicks it", async (id, actionType, [attr, value]) => {
    f.appear[actionType] = [[`${attr}`, value]];
    show(row(id));
    expect(spot()).toBeNull();
    flushSync(() => openButton()!.click());
    await vi.waitFor(() => expect(spot()).not.toBeNull());
    expect(actions.map((action) => action.type)).toEqual([actionType]);
    expect(spot()!.getAttribute("data-spot")).toBe(value);
    expect(spot()!.getAttribute("data-spot-attr")).toBe(attr);
    expect(host.querySelector("[data-ui-place-hint]")!.textContent).toContain("Click the highlighted control yourself");
    expect(clicked).toEqual([]);
  });

  it("spotlights the control that opens a closed menu when the control itself is not on screen", async () => {
    draw("ui", "sidebar.new");
    show(row("sidebar.new-bot"));
    flushSync(() => openButton()!.click());
    await vi.waitFor(() => expect(spot()).not.toBeNull());
    expect(actions).toEqual([]);
    expect(spot()!.getAttribute("data-spot")).toBe("sidebar.new");
    expect(host.textContent).toContain("Click New bot");
    expect(clicked).toEqual([]);
  });

  it("closes the spotlight with Got it", async () => {
    draw("ui", "sidebar.search");
    show(row("sidebar.search"));
    flushSync(() => openButton()!.click());
    await vi.waitFor(() => expect(spot()).not.toBeNull());
    flushSync(() => host.querySelector<HTMLButtonElement>("[data-spot-done]")!.click());
    expect(spot()).toBeNull();
  });

  it("shows the clicks as text, and no button, for a place this mode hides", () => {
    f.advanced = false;
    show(row("chat.find"));
    expect(openButton()).toBeNull();
    expect(host.querySelector("[data-ui-place-mode]")!.textContent).toContain("Advanced mode only");
    expect(host.querySelector("[data-ui-place-steps]")!.textContent).toContain("Click the bot's name at the top left of the chat, then Details, then Find in conversation");
    expect(actions).toEqual([]);
  });

  it("shows the clicks when the control is not on screen after the page opened", async () => {
    show(row("board.new-task"));
    flushSync(() => openButton()!.click());
    await vi.waitFor(() => expect(host.querySelector("[data-ui-place-missing]")).not.toBeNull(), { timeout: 4000 });
    expect(spot()).toBeNull();
    expect(host.querySelector("[data-ui-place-steps]")!.textContent).toContain("Click New task, at the top right of the page");
    expect(clicked).toEqual([]);
  });

  it("shows the row's fixed text for an id this client does not know", () => {
    show(row("sidebar.from-a-newer-map", "A newer place: somewhere."));
    expect(host.textContent).toBe("A newer place: somewhere.");
    expect(host.querySelector("button")).toBeNull();
  });

  it("treats prototype names as unknown ids", () => {
    show(row("__proto__", "Fixed text."));
    expect(host.textContent).toBe("Fixed text.");
  });
});
