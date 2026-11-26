// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";

// DesktopCapabilities reads window.ogb at module scope.
vi.mock("../DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { host: { homeDir: undefined, platform: "other" } } }),
}));

const { MemoryUpkeepCard } = await import("./MemorySection");

let host: HTMLDivElement;
let root: Root;
const noop = () => undefined;
const onQuietMinutes = vi.fn();
const onTidyHour = vi.fn();
const timing = { quietMinutes: 5, tidyHour: 3, saving: false, error: "", onQuietMinutes, onTidyHour };
const render = (props: { enabled?: boolean; timing?: typeof timing } = {}) =>
  flushSync(() => root.render(createElement(MemoryUpkeepCard, { enabled: props.enabled ?? true, status: null, tidying: false, onToggle: noop, onTidy: noop, timing: props.timing ?? timing })));
const minutes = () => host.querySelector<HTMLInputElement>("#memory-quiet-minutes")!;
const hour = () => host.querySelector<HTMLSelectElement>("#memory-tidy-hour")!;

beforeEach(() => {
  vi.clearAllMocks();
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("memory upkeep timing rows", () => {
  it("shows both rows with labelled controls while upkeep is on", () => {
    render();
    expect(host.textContent).toContain("Notice new facts after");
    expect(host.textContent).toContain("Tidy memory at");
    expect(minutes().value).toBe("5");
    expect(host.querySelector('label[for="memory-quiet-minutes"]')).not.toBeNull();
    expect(host.querySelector('label[for="memory-tidy-hour"]')).not.toBeNull();
    expect(hour().options).toHaveLength(24);
    expect(hour().value).toBe("3");
  });

  it("hides them while upkeep is off or the server reports no timing", () => {
    render({ enabled: false });
    expect(host.querySelector("#memory-quiet-minutes")).toBeNull();
    flushSync(() => root.render(createElement(MemoryUpkeepCard, { enabled: true, status: null, tidying: false, onToggle: noop, onTidy: noop })));
    expect(host.querySelector("#memory-quiet-minutes")).toBeNull();
  });

  it("saves a changed number of minutes", () => {
    render();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(minutes(), "20");
    flushSync(() => minutes().dispatchEvent(new Event("input", { bubbles: true })));
    flushSync(() => minutes().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(onQuietMinutes).toHaveBeenCalledWith(20);
  });

  it("does not save minutes outside the range", () => {
    render();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(minutes(), "1441");
    flushSync(() => minutes().dispatchEvent(new Event("input", { bubbles: true })));
    flushSync(() => minutes().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(onQuietMinutes).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("from 1 to 1440");
  });

  it("saves a chosen hour", () => {
    render();
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(hour(), "22");
    flushSync(() => hour().dispatchEvent(new Event("change", { bubbles: true })));
    expect(onTidyHour).toHaveBeenCalledWith(22);
  });

  it("shows a failed save inline", () => {
    render({ timing: { ...timing, error: "Could not save the memory timing." } });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Could not save the memory timing.");
  });
});
