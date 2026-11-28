// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { GlanceRow } from "./GlanceRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root | null = null;
let saved: { on: boolean };
let changed: ((state: { on: boolean }) => void) | null;
const set = vi.fn(async (on: boolean) => { saved = { on }; return saved; });
const unsubscribe = vi.fn();

beforeEach(() => {
  setLocale("en");
  saved = { on: true };
  changed = null;
  set.mockClear(); unsubscribe.mockClear();
  Object.assign(window, { ogb: { glance: { feed: () => {}, onAct: () => () => {}, state: async () => saved, set,
    onChange: (cb: (state: { on: boolean }) => void) => { changed = cb; return unsubscribe; } } } });
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); delete (window as { ogb?: unknown }).ogb; });

async function mount() {
  root = createRoot(host);
  await act(async () => root!.render(createElement(GlanceRow)));
  await act(async () => { await Promise.resolve(); });
}
const toggle = () => host.querySelector<HTMLButtonElement>('[aria-label="Glance"]');

describe("Settings' switch for Glance", () => {
  it("is on by default and turns Glance off, then on again", async () => {
    await mount();
    expect(host.textContent).toContain("Glance");
    expect(host.textContent).toContain("top of the screen");
    expect(toggle()?.getAttribute("aria-checked")).toBe("true");
    await act(async () => { toggle()!.click(); await Promise.resolve(); });
    expect(set).toHaveBeenLastCalledWith(false);
    expect(toggle()?.getAttribute("aria-checked")).toBe("false");
    await act(async () => { toggle()!.click(); await Promise.resolve(); });
    expect(set).toHaveBeenLastCalledWith(true);
    expect(toggle()?.getAttribute("aria-checked")).toBe("true");
  });

  it("shows off when Glance was turned off before, and follows the View menu or the tray", async () => {
    saved = { on: false };
    await mount();
    expect(toggle()?.getAttribute("aria-checked")).toBe("false");
    await act(async () => { changed!({ on: true }); });
    expect(toggle()?.getAttribute("aria-checked")).toBe("true");
    await act(async () => root!.unmount());
    root = null;
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("is nowhere without Glance's switch: a browser, or an older app", async () => {
    Object.assign(window, { ogb: { glance: { feed: () => {}, onAct: () => () => {} } } });
    await mount();
    expect(toggle()).toBeNull();
    await act(async () => root!.unmount());
    delete (window as { ogb?: unknown }).ogb;
    await mount();
    expect(toggle()).toBeNull();
  });
});
