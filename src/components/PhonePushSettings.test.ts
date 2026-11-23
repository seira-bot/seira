// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { PhonePushSettings } from "./PhonePushSettings";

const fixture = vi.hoisted(() => ({
  config: undefined as Record<string, unknown> | undefined,
  api: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }),
}));

let host: HTMLDivElement;
let root: Root;
const render = () => flushSync(() => root.render(createElement(PhonePushSettings)));
const toggle = () => host.querySelector<HTMLButtonElement>('button[aria-label="Alerts when the phone app is closed"]');

beforeEach(() => {
  vi.clearAllMocks();
  setLocale("en");
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

describe("Alerts when the phone app is closed", () => {
  it("is not shown by a server with no push relay, which leaves the flag out", () => {
    fixture.config = { features: { usbPhoneTakeover: false } };
    render();
    expect(host.textContent).toBe("");
    expect(host.querySelector('[data-settings-block="phone-push"]')).toBeNull();
  });

  it("starts off, and turns on as features.phonePush with the server's answer", async () => {
    fixture.config = { features: { phonePush: false } };
    const saved = { features: { phonePush: true } };
    fixture.api.mockResolvedValue(saved);
    render();
    expect(host.querySelector('[data-settings-block="phone-push"]')).not.toBeNull();
    expect(toggle()!.getAttribute("aria-checked")).toBe("false");
    expect(host.textContent).toContain("Approvals, questions, sign-ins and finished replies reach your phone even when the app is closed.");
    expect(host.textContent).not.toContain("never the message itself");
    flushSync(() => [...host.querySelectorAll("button")].find((button) => !button.hasAttribute("aria-label"))!.click());
    expect(host.textContent).toContain("through Apple or Google. It holds the bot and room names and the kind of alert, never the message itself.");

    flushSync(() => toggle()!.click());
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: saved }));
    expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/config", {
      method: "PATCH",
      body: JSON.stringify({ features: { phonePush: true } }),
    });
    render();
    expect(toggle()!.getAttribute("aria-checked")).toBe("true");
  });

  it("turns off again, and shows a refusal from the server", async () => {
    fixture.config = { features: { phonePush: true } };
    fixture.api.mockRejectedValue(new Error("only an admin may change this"));
    render();
    flushSync(() => toggle()!.click());
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toBe("only an admin may change this"));
    expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/config", {
      method: "PATCH",
      body: JSON.stringify({ features: { phonePush: false } }),
    });
    expect(toggle()!.getAttribute("aria-checked")).toBe("true");
  });
});
