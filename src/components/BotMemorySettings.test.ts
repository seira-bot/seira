// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { BotMemorySettings } from "./BotMemorySettings";

const fixture = vi.hoisted(() => ({
  config: undefined as Record<string, unknown> | undefined,
  api: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }),
}));

const base = { rooms: { turnTimeoutMinutes: 5 }, composio: { configured: false }, box: { configured: false }, vps: { configured: false, sshAlias: "" } };
const memory = (over: Record<string, unknown> = {}) => ({ gb: null, autoGb: 12, machineGb: 16, protection: "slice", envGb: null, ...over });

let host: HTMLDivElement;
let root: Root;
const render = () => flushSync(() => root.render(createElement(BotMemorySettings)));
const input = () => host.querySelector<HTMLInputElement>("#bot-memory")!;
const type = (value: string) => {
  const field = input();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  flushSync(() => field.dispatchEvent(new Event("input", { bubbles: true })));
};
const blur = () => flushSync(() => input().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  setLocale("en");
  fixture.config = { ...base, botMemory: memory() };
  fixture.dispatch.mockImplementation((action: { type: string; config?: Record<string, unknown> }) => {
    if (action.type === "configStatus") fixture.config = action.config;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("BotMemorySettings", () => {
  it("renders nothing where the server offers no protection", () => {
    fixture.config = base;
    render();
    expect(host.innerHTML).toBe("");
  });

  it("shows the row where the Windows job or the watchdog enforces the limit", () => {
    for (const protection of ["job", "watchdog"]) {
      fixture.config = { ...base, botMemory: memory({ protection }) };
      render();
      expect(host.textContent).toContain("Memory for bots");
      expect(input().disabled).toBe(false);
    }
  });

  it("shows an empty field with the Auto size as placeholder", () => {
    render();
    expect(input().value).toBe("");
    expect(input().placeholder).toBe("Auto (12 GB)");
    expect(input().disabled).toBe(false);
  });

  it("AC-09: saves a valid number as { botMemoryGb: n }", async () => {
    const saved = { ...base, botMemory: memory({ gb: 8 }) };
    fixture.api.mockResolvedValue(saved);
    render();
    type("8");
    blur();
    await settle();
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ botMemoryGb: 8 }) });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: saved });
    expect(input().value).toBe("8");
  });

  it("AC-09: saves an emptied field as { botMemoryGb: null }", async () => {
    fixture.config = { ...base, botMemory: memory({ gb: 8 }) };
    fixture.api.mockResolvedValue({ ...base, botMemory: memory() });
    render();
    type("");
    blur();
    await settle();
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ botMemoryGb: null }) });
    expect(input().value).toBe("");
  });

  it.each(["0.5", "17"])("AC-10: refuses %s with the range text and no save", async (text) => {
    render();
    type(text);
    blur();
    await settle();
    expect(fixture.api).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Enter a number of GB from 1 to 16.");
  });

  it("shows the server message when a save fails, else the plain error", async () => {
    fixture.api.mockRejectedValueOnce(new Error("Too much"));
    render();
    type("4");
    blur();
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Too much");
    fixture.api.mockRejectedValueOnce("x");
    type("5");
    blur();
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Couldn't save the memory limit. Try again.");
  });

  it("disables the field and explains it when the limit was fixed at start", () => {
    fixture.config = { ...base, botMemory: memory({ envGb: 6 }) };
    render();
    expect(input().value).toBe("6");
    expect(input().disabled).toBe(true);
    expect(host.textContent).toContain("Set to 6 GB when this app started, so it can't be changed here.");
    expect(fixture.api).not.toHaveBeenCalled();
  });
});
