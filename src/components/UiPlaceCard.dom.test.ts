// @vitest-environment happy-dom
import { createContext, createElement, Fragment, useCallback, useContext, useReducer, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { initialState, reducer, type AppState, type Message } from "@/state/store";

type Action = { type: string; [key: string]: unknown };
/** `appear` maps an action type to the elements the app draws after it, as attribute and value. `record` sees the actions the card sends, not the host's answers. */
const f = vi.hoisted(() => ({ advanced: true, record: (_action: Action) => {}, appear: {} as Record<string, [string, string][]> }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => f.advanced, readAdvancedMode: () => f.advanced }));
// The store is the real reducer from the real initial state; only the provider is small, so a page change really changes `activeView`.
const StoreContext = createContext<{ state: AppState; dispatch: (action: Action) => void } | null>(null);
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), useStore: () => useContext(StoreContext)! }));
vi.mock("./onboarding/Spotlight", async () => {
  const { createElement: h } = await import("react");
  return { Spotlight: (props: { anchor: string; attr?: string; primary?: { label: string; onClick: () => void }; children: ReactNode }) =>
    h("div", { "data-spot": props.anchor, "data-spot-attr": props.attr ?? "tour" }, props.children, props.primary && h("button", { "data-spot-done": "", onClick: props.primary.onClick }, props.primary.label)) };
});

const { RichMessageRow, richRowKind } = await import("./RichMessageRow");
const { PlaceLookHost } = await import("./PlaceLookHost");

const row = (id: string, text = "The server's own words."): Message => ({ id: "m1", role: "bot", kind: "text", text, uiPlace: { id } }) as unknown as Message;

let host: HTMLDivElement;
let screen: HTMLDivElement;
let root: Root;
let actions: Action[];
let clicked: string[];
/** What each page, by `activeView`, draws when it is on the screen, as attribute and value. */
let pages: Record<string, [string, string][]>;

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
  pages = {};
  actions = [];
  clicked = [];
  f.record = (action) => { if (action.type !== "placeLookResult") actions.push(action); };
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

function Provider({ children }: { children: ReactNode }) {
  const [state, apply] = useReducer(reducer, initialState);
  const dispatch = useCallback((action: Action) => {
    f.record(action);
    apply(action as never);
    for (const [attr, value] of f.appear[action.type] ?? []) draw(attr, value);
  }, []);
  return createElement(StoreContext.Provider, { value: { state, dispatch } }, children);
}

/** Like App: the chat page or another page, and the host that stays mounted over the change. */
function Shell({ message }: { message: Message }) {
  const { state } = useContext(StoreContext)!;
  const page = state.activeView === "chat"
    ? createElement(RichMessageRow, { botId: "kiwi", botName: "Kiwi", threadId: "t-kiwi", message })
    : createElement("div", { "data-page": state.activeView }, (pages[state.activeView] ?? []).map(([attr, value]) => createElement("button", { key: value, [`data-${attr}`]: value, onClick: () => clicked.push(`${attr}:${value}`) })));
  return createElement(Fragment, null, page, createElement(PlaceLookHost));
}

function show(message: Message) {
  flushSync(() => root.render(createElement(Provider, null, createElement(Shell, { message }))));
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
    expect(actions.map((action) => action.type)).toEqual([actionType, "lookForPlace"]);
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
    expect(actions).toEqual([{ type: "lookForPlace", id: "sidebar.new-bot" }]);
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
    show(row("chat.screen"));
    flushSync(() => openButton()!.click());
    await vi.waitFor(() => expect(host.querySelector("[data-ui-place-missing]")).not.toBeNull(), { timeout: 4000 });
    expect(spot()).toBeNull();
    expect(host.querySelector("[data-ui-place-steps]")!.textContent).toContain("Click the monitor button at the top right of the chat");
    expect(clicked).toEqual([]);
  });

  // The actions of these places change `activeView`, and the page replaces the chat page: the card is gone before the control is.
  it.each([
    ["board.new-task", "showBoard", "board", ["ui", "board.new-task"]],
    ["automations.page", "showRoutines", "routines", ["tour", "automations-page"]],
    ["automations.workflows", "showRoutines", "routines", ["ui", "automations.workflows"]],
  ] as const)("%s: the spotlight stays over the page change that unmounts the card", async (id, actionType, view, [attr, value]) => {
    pages[view] = [[attr, value]];
    show(row(id));
    flushSync(() => openButton()!.click());
    expect(openButton()).toBeNull();
    expect(host.querySelector(`[data-page='${view}']`)).not.toBeNull();
    await vi.waitFor(() => expect(spot()).not.toBeNull());
    expect(actions.map((action) => action.type)).toEqual([actionType, "lookForPlace"]);
    expect(spot()!.getAttribute("data-spot")).toBe(value);
    expect(spot()!.getAttribute("data-spot-attr")).toBe(attr);
    expect(host.querySelector("[data-ui-place-hint]")!.textContent).toContain("Click the highlighted control yourself");
    expect(clicked).toEqual([]);
    flushSync(() => host.querySelector<HTMLButtonElement>("[data-spot-done]")!.click());
    expect(spot()).toBeNull();
  });

  it("says the control is not there on a page that replaced the chat, where the card is gone", async () => {
    pages.board = [];
    show(row("board.new-task"));
    flushSync(() => openButton()!.click());
    expect(openButton()).toBeNull();
    await vi.waitFor(() => expect(host.querySelector("[data-ui-place-lost]")).not.toBeNull(), { timeout: 4000 });
    expect(spot()).toBeNull();
    expect(host.textContent).toContain("Click New task, at the top right of the page");
    flushSync(() => host.querySelector<HTMLButtonElement>("[data-spot-done]")!.click());
    expect(host.querySelector("[data-ui-place-lost]")).toBeNull();
  });

  it("drops the answer of an older look when the person asked again", () => {
    const first = reducer(initialState, { type: "lookForPlace", id: "board.new-task" });
    const second = reducer(first, { type: "lookForPlace", id: "files.upload" });
    const late = reducer(second, { type: "placeLookResult", nonce: first.placeLook!.nonce, phase: "spot", anchor: { attr: "ui", value: "board.new-task" } });
    expect(late.placeLook).toMatchObject({ id: "files.upload", phase: "looking" });
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
