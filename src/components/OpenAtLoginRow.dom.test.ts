// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { OpenAtLoginRow } from "./OpenAtLoginRow";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(state: { available: boolean; on: boolean; startupApps?: boolean }) {
  vi.stubGlobal("window", Object.assign(window, { ogb: { openAtLogin: { state: async () => state, set: async () => state } } }));
  flushSync(() => root.render(createElement(OpenAtLoginRow)));
  await vi.waitFor(() => expect(host.textContent).not.toBe(""));
}

describe("the Open at login row", () => {
  it("shows the switch where the app can turn it on", async () => {
    await render({ available: true, on: false });
    expect(host.textContent).toContain("Open at login");
    expect(host.querySelector('[role="switch"], button[aria-label="Open at login"]')).not.toBeNull();
  });

  it("points to Startup apps, with no switch, where only Windows can turn it on", async () => {
    await render({ available: false, on: false, startupApps: true });
    expect(host.textContent).toContain("Open at login");
    expect(host.textContent).toContain("turn it on in Startup apps in Windows Settings");
    expect(host.querySelector("button, [role='switch']")).toBeNull();
  });

  it("shows nothing where it cannot work", async () => {
    vi.stubGlobal("window", Object.assign(window, { ogb: { openAtLogin: { state: async () => ({ available: false, on: false }), set: async () => ({ available: false, on: false }) } } }));
    flushSync(() => root.render(createElement(OpenAtLoginRow)));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(host.textContent).toBe("");
  });
});
