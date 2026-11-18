// @vitest-environment happy-dom
// The panel's state pill, quick-action tiles and tab keys in a real DOM.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelQuickActions } from "./PanelQuickActions";
import { PanelStatePill } from "./PanelStatePill";
import { PanelTabs } from "./PanelTabs";

let root: Root | null = null;
let host: HTMLElement | null = null;
function mount(node: ReturnType<typeof createElement>) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(node));
}
afterEach(() => {
  flushSync(() => root?.unmount());
  host?.remove();
});

describe("PanelStatePill", () => {
  it("shows nothing while the bot is idle", () => {
    mount(createElement(PanelStatePill, { bot: { busy: false, activity: "idle" } }));
    expect(document.querySelector("[data-panel-state]")).toBeNull();
  });
  it("shows working and waiting", () => {
    mount(createElement(PanelStatePill, { bot: { busy: true, activity: "working" } }));
    expect(document.querySelector("[data-panel-state]")?.getAttribute("data-panel-state")).toBe("working");
    flushSync(() => root!.render(createElement(PanelStatePill, { bot: { busy: false, activity: "waiting-on-you" } })));
    expect(document.querySelector("[data-panel-state]")?.getAttribute("data-panel-state")).toBe("waiting");
  });
});

describe("PanelQuickActions", () => {
  it("calls back with the tile's action", () => {
    const onAction = vi.fn();
    mount(createElement(PanelQuickActions, { onAction }));
    const tiles = [...document.querySelectorAll<HTMLElement>("[data-panel-quick-action]")];
    expect(tiles.map((tile) => tile.dataset.panelQuickAction)).toEqual(["message", "computer", "routines", "settings"]);
    flushSync(() => tiles[2]!.click());
    expect(onAction).toHaveBeenCalledWith("routines");
    flushSync(() => root!.render(createElement(PanelQuickActions, { onAction, canMessage: false })));
    expect(document.querySelector('[data-panel-quick-action="message"]')).toBeNull();
  });
});

describe("PanelTabs", () => {
  it("moves with the arrow keys and Home and End", () => {
    const onSelect = vi.fn();
    mount(createElement(PanelTabs, { tab: "details", onSelect }));
    const list = document.querySelector<HTMLElement>('[role="tablist"]')!;
    const press = (key: string) => flushSync(() => { list.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
    press("ArrowRight");
    expect(onSelect).toHaveBeenLastCalledWith("library");
    press("End");
    expect(onSelect).toHaveBeenLastCalledWith("computer");
    flushSync(() => root!.render(createElement(PanelTabs, { tab: "computer", onSelect })));
    press("ArrowRight");
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-panel-tab="computer"]')?.getAttribute("tabindex")).toBe("0");
    expect(document.querySelector('[data-panel-tab="library"]')?.getAttribute("tabindex")).toBe("-1");
  });
});
