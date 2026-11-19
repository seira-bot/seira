import { Children, createElement, isValidElement, type MemoExoticComponent, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, type AppState, type Bot, type Group } from "@/state/store";

const fixture = vi.hoisted(() => ({ advanced: true, showThreads: true, state: {} as Partial<AppState>, dispatch: vi.fn() }));
vi.mock("@/lib/interface-mode", async (original) => ({
  ...await original<typeof import("@/lib/interface-mode")>(),
  useAdvancedMode: () => fixture.advanced,
}));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => fixture.showThreads }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));
vi.mock("react-dom", () => ({ createPortal: (node: ReactNode) => node }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, ...fixture.state }, dispatch: fixture.dispatch }) };
});
vi.mock("@/state/store-select", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store-select")>();
  return {
    ...original,
    useStoreDispatch: () => fixture.dispatch,
    useStoreSelector: <T,>(select: (state: AppState) => T) => select({ ...initialState, ...fixture.state } as AppState),
  };
});

import { BotListItem, botRowProps, GroupListItem, type BotRowProps } from "./Sidebar";

const bot = (id: string, extra: Partial<Bot> = {}): Bot => ({
  id, threadId: `${id}-thread`, name: id[0]!.toUpperCase() + id.slice(1), title: "", description: "", notifications: true,
  color: "green", unread: false, modelSelection: { instanceId: "fake", model: "m" }, messages: [], ...extra,
});
const atlas = bot("atlas", { title: "Developer", messages: [{ id: "m1", role: "bot", kind: "text", text: "All set.", at: 1 }] as Bot["messages"] });
const chief = bot("chief", { chiefOfStaff: true, title: "Planner" });
const room: Group = {
  id: "room", threadId: "room-thread", name: "Launch room", memberIds: ["atlas", "chief"], messages: [{ id: "g1", role: "bot", kind: "text", text: "Ship it.", at: 1 }] as Group["messages"],
  defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 1,
};
const threadRoom: Group = { ...room, id: "thread", name: "Release notes", dm: true } as Group;

const drawBot = (BotListItem as MemoExoticComponent<(props: BotRowProps) => ReactNode>).type;
const drawGroup = (GroupListItem as MemoExoticComponent<(props: ReactElement["props"]) => ReactNode>).type;
const rowProps = (candidate: Bot) => botRowProps({ ...initialState, ...fixture.state } as AppState, fixture.dispatch, candidate, { density: "comfortable", query: "", onMenu: vi.fn() });

type ElementProps = { children?: ReactNode; onClick?: (event: MouseEvent) => void; [key: string]: unknown };
function findElement(tree: ReactNode, attribute: string, value: string): ReactElement<ElementProps> | undefined {
  for (const child of Children.toArray(tree)) {
    if (!isValidElement<ElementProps>(child)) continue;
    if (child.props[attribute] === value) return child;
    const found = findElement(child.props.children, attribute, value);
    if (found) return found;
  }
}
function capture(draw: () => ReactNode) {
  let tree: ReactNode;
  const html = renderToStaticMarkup(createElement(function Capture() { tree = draw(); return tree; }));
  return { tree, html };
}
const click = { type: "click", target: {} } as MouseEvent;

beforeEach(() => {
  fixture.advanced = true;
  fixture.showThreads = true;
  fixture.state = { bots: [atlas, chief], groups: [room, threadRoom], selectedId: "other", activeView: "chat" };
  fixture.dispatch.mockClear();
  vi.stubGlobal("window", { innerWidth: 1440, innerHeight: 900 });
  vi.stubGlobal("document", { body: {} });
  vi.stubGlobal("HTMLInputElement", class {});
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("Advanced bot row", () => {
  it("draws the avatar, the name, the time and a one-line preview, with the role in the tooltip", () => {
    const { html } = capture(() => drawBot(rowProps(atlas)));
    expect(html).toContain('data-avatar-kind="bot"');
    expect(html).toContain(">Atlas</span>");
    expect(html).toMatch(/tabular-nums[^>]*>[^<]+<\/span>/);
    expect(html).toContain(">All set.</span>");
    expect(html).toContain('title="Atlas · Developer"');
    expect(html).not.toContain('data-testid="bot-role"');
  });

  it("marks the Chief of Staff with a crown and names the role in the tooltip", () => {
    const { html } = capture(() => drawBot(rowProps(chief)));
    expect(html.match(/data-testid="chief-crown"/g)).toHaveLength(1);
    expect(html).toContain('title="Chief · Planner · Chief of Staff"');
  });

  it("opens the same bot a Simple row opens, from the mouse and from the keyboard", () => {
    const opened: unknown[] = [];
    for (const advanced of [false, true]) {
      fixture.advanced = advanced;
      const { tree } = capture(() => drawBot(rowProps(atlas)));
      const row = findElement(tree, "data-sidebar-bot-row", "atlas")!;
      fixture.dispatch.mockClear();
      row.props.onClick!(click);
      opened.push(fixture.dispatch.mock.calls.map(([action]) => action));
      fixture.dispatch.mockClear();
      (row.props.onKeyDown as (event: unknown) => void)({ key: "Enter", preventDefault: vi.fn() });
      expect(fixture.dispatch.mock.calls.map(([action]) => action)).toEqual(opened.at(-1));
    }
    expect(opened[1]).toEqual(opened[0]);
    expect(opened[1]).toEqual([{ type: "select", id: "atlas" }]);
  });

  it("keeps the thread and folder buttons and the actions menu beside the row", () => {
    const { html } = capture(() => drawBot(rowProps(atlas)));
    expect(html).toContain('aria-label="New thread"');
    expect(html).toContain('aria-label="New folder under Atlas"');
    expect(html).toContain('aria-label="Actions for Atlas"');
  });
});

describe("Advanced group chat row", () => {
  const props = (group: Group) => ({ group, density: "comfortable" as const, onMenu: vi.fn() });

  it("draws the stacked avatars, the title, the time and the last message", () => {
    const { html } = capture(() => drawGroup(props(room)));
    expect(html).toContain(">Launch room</span>");
    expect(html).toContain(">Ship it.</span>");
    expect(html).toContain('data-sidebar-group-row="room"');
  });

  it("opens the same room in Simple and in Advanced", () => {
    for (const advanced of [false, true]) {
      fixture.advanced = advanced;
      const { tree } = capture(() => drawGroup(props(room)));
      fixture.dispatch.mockClear();
      findElement(tree, "data-sidebar-group-row", "room")!.props.onClick!(click);
      expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "select", id: "room" });
    }
  });

  it("draws a bot thread as a compact row and opens that thread", () => {
    const { tree, html } = capture(() => drawGroup(props(threadRoom)));
    expect(html).toContain(">Release notes</span>");
    expect(String(findElement(tree, "data-sidebar-group-row", "thread")!.props.className)).toContain("h-8");
    fixture.dispatch.mockClear();
    findElement(tree, "data-sidebar-group-row", "thread")!.props.onClick!(click);
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "select", id: "thread" });
  });
});
