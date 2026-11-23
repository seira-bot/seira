// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { TEXT_SIZE_STEPS } from "../../shared/app-settings";
import { TEXT_SIZE_STEPS as DESKTOP_STEPS } from "../../electron/text-size.mjs";
import { SETTINGS_PLACES } from "../../shared/settings-places";
import { TextSizeRow } from "./AppearanceSelectRows";
import { fullContext, SETTINGS_INDEX, searchSettings } from "./settings/settings-index";
import { t } from "@/lib/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root | null = null;
let announce: ((step: number) => void) | null = null;
const set = vi.fn(async (step: number) => step);
const stop = vi.fn();

beforeEach(() => {
  setLocale("en");
  announce = null;
  set.mockClear(); stop.mockClear();
  Object.assign(window, { ogb: { textSize: { get: async () => 1.25, set, onChange: (cb: (step: number) => void) => { announce = cb; return stop; } } } });
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); delete (window as { ogb?: unknown }).ogb; });

async function mount() {
  root = createRoot(host);
  await act(async () => root!.render(createElement(TextSizeRow)));
  await act(async () => { await Promise.resolve(); });
}
const select = () => host.querySelector<HTMLSelectElement>('select[aria-label="Text size"]');

describe("Settings' Text size row", () => {
  it("AC-01 shows the saved step, the line and the seven steps with 100 % marked as the default", async () => {
    await mount();
    expect(host.textContent).toContain("Makes text and controls larger or smaller on this device.");
    expect(select()?.value).toBe("1.25");
    expect([...select()!.options].map((option) => option.textContent)).toEqual(["90 %", "100 % (default)", "110 %", "125 %", "150 %", "175 %", "200 %"]);
  });

  it("AC-02 sends the chosen step to the window at once", async () => {
    await mount();
    await act(async () => { select()!.value = "1.5"; select()!.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); });
    expect(set).toHaveBeenCalledWith(1.5);
    expect(select()?.value).toBe("1.5");
  });

  it("AC-05 follows a step the View menu or a shortcut changed, and stops listening when it goes", async () => {
    await mount();
    await act(async () => announce!(1.75));
    expect(select()?.value).toBe("1.75");
    await act(async () => root!.unmount());
    root = null;
    expect(stop).toHaveBeenCalledOnce();
  });

  it("AC-09 renders nothing where the page has no desktop bridge", async () => {
    delete (window as { ogb?: unknown }).ogb;
    await mount();
    expect(host.innerHTML).toBe("");
  });

  it("AC-09 renders nothing on an older desktop app that has no text size bridge", async () => {
    Object.assign(window, { ogb: {} });
    await mount();
    expect(host.innerHTML).toBe("");
  });

  it("keeps the steps of the app and of the desktop window the same", () => {
    expect([...DESKTOP_STEPS]).toEqual([...TEXT_SIZE_STEPS]);
  });
});

describe("Text size in Settings' index", () => {
  const entry = SETTINGS_INDEX.find((candidate) => candidate.id === "text-size")!;

  it("AC-01 sits in Appearance, Look, with no Advanced flag, so Simple and Advanced both show it", () => {
    expect(entry).toMatchObject({ page: "appearance", anchor: "look" });
    expect(entry.advanced).toBeUndefined();
    expect(SETTINGS_PLACES.find((place) => place.id === "text-size")).toMatchObject({ path: "Settings → Appearance → Text size", only: "the desktop app" });
    expect(SETTINGS_PLACES.find((place) => place.id === "text-size")).not.toHaveProperty("advanced");
  });

  it.each(["text size", "font size", "zoom", "bigger text"])("finds it by %s", (query) => {
    const hits = searchSettings(query, fullContext(), (item) => t(item.labelKey), (page) => t(page.labelKey));
    expect(hits[0]?.entry.id).toBe("text-size");
  });
});
