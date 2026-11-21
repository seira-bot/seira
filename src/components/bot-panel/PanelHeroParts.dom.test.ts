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
    press("ArrowLeft");
    expect(onSelect).toHaveBeenLastCalledWith("activity");
    press("Home");
    expect(onSelect).toHaveBeenLastCalledWith("activity");
    press("End");
    expect(onSelect).toHaveBeenLastCalledWith("computer");
    flushSync(() => root!.render(createElement(PanelTabs, { tab: "computer", onSelect })));
    press("ArrowRight");
    expect(onSelect).toHaveBeenCalledTimes(4);
    expect(document.querySelector('[data-panel-tab="computer"]')?.getAttribute("tabindex")).toBe("0");
    expect(document.querySelector('[data-panel-tab="library"]')?.getAttribute("tabindex")).toBe("-1");
  });

  it("sizes the thumb to the selected tab's box and moves it with the selection", () => {
    const boxes: Record<string, [number, number]> = { activity: [3, 71], details: [74, 60], library: [134, 58], computer: [192, 90] };
    const left = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetLeft");
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    const box = (element: HTMLElement) => boxes[element.dataset.panelTab ?? ""];
    Object.defineProperty(HTMLElement.prototype, "offsetLeft", { configurable: true, get(this: HTMLElement) { return box(this)?.[0] ?? 0; } });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get(this: HTMLElement) { return box(this)?.[1] ?? 0; } });
    try {
      const onSelect = vi.fn();
      mount(createElement(PanelTabs, { tab: "details", onSelect }));
      const thumb = () => document.querySelector<HTMLElement>("[data-segment-thumb]")!;
      expect([thumb().style.width, thumb().style.transform]).toEqual(["60px", "translateX(74px)"]);
      flushSync(() => root!.render(createElement(PanelTabs, { tab: "computer", onSelect })));
      expect([thumb().style.width, thumb().style.transform]).toEqual(["90px", "translateX(192px)"]);
    } finally {
      if (left) Object.defineProperty(HTMLElement.prototype, "offsetLeft", left); else Reflect.deleteProperty(HTMLElement.prototype, "offsetLeft");
      if (width) Object.defineProperty(HTMLElement.prototype, "offsetWidth", width); else Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
    }
  });
});
