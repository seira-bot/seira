// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { Message } from "@/state/store";

vi.mock("@/lib/companion-bridge", () => ({ pageIsThisComputer: () => false }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: {} }, dispatch: () => {} }), api: async () => ({}) }));
vi.mock("./AdminOnly", () => ({ AdminOnly: ({ children }: { children: unknown }) => children }));
vi.mock("./AiPoolSettings", async () => {
  const { createElement: h } = await import("react");
  return { AiPoolSettings: () => h("div", { "data-ai-pool-control": "" }, "pool control") };
});

const { SettingsCard } = await import("./SettingsCard");

const message = { id: "m1", role: "bot", kind: "text", text: "AI pool: open Settings.", settingsCard: { id: "ai-pool" } } as unknown as Message;
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
});

describe("the AI pool card in chat", () => {
  it("AC-08: draws the AI pool control from Settings, on any computer", async () => {
    flushSync(() => root.render(createElement(SettingsCard, { message })));
    await vi.waitFor(() => expect(host.querySelector("[data-ai-pool-control]")).not.toBeNull());
    expect(host.querySelector('[data-settings-card="ai-pool"][data-settings-look="simple"]')).not.toBeNull();
    expect(host.querySelector("[data-settings-card-elsewhere]")).toBeNull();
    expect(host.textContent).not.toContain("Settings.");
  });
});
