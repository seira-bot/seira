// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { CrashReportsRow } from "./CrashReportsRow";

type Bridge = { available: boolean; enabled: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; report: ReturnType<typeof vi.fn>; page: ReturnType<typeof vi.fn> };
let bridge: Bridge;
let host: HTMLDivElement;
let root: Root;

const setBridge = (value: unknown) => { (window as unknown as { ogb: unknown }).ogb = value === undefined ? {} : { crashReports: value }; };
const show = async () => { await act(async () => { root.render(createElement(CrashReportsRow)); }); };
const toggle = () => host.querySelector<HTMLButtonElement>('button[aria-label="Send crash reports"]')!;

beforeEach(() => {
  setLocale("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  bridge = { available: true, enabled: vi.fn(() => true), set: vi.fn(async () => undefined), report: vi.fn(), page: vi.fn() };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  delete (window as unknown as { ogb?: unknown }).ogb;
  vi.unstubAllGlobals();
});

describe("CrashReportsRow", () => {
  it("is hidden in a browser, with no bridge, and when the build cannot send reports (AC-16)", async () => {
    setBridge(undefined);
    await show();
    expect(host.textContent).toBe("");
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    setBridge({ ...bridge, available: false });
    await show();
    expect(host.textContent).toBe("");
  });

  it("shows the title, the sentence and the help link, and the switch is on when the app says so (AC-01)", async () => {
    setBridge(bridge);
    await show();
    expect(host.textContent).toContain("Send crash reports");
    expect(host.textContent).toContain("When Seira stops working, it sends the app version, system type, and where its code failed, never your messages, files, or names.");
    expect(host.querySelector("a")?.getAttribute("href")).toBe("https://github.com/seira-bot/seira/blob/main/docs/crash-reports.md");
    expect(host.querySelector("a")?.textContent).toBe("What a report contains");
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });

  it("reads the switch as off when the app says off, and turns it off and on", async () => {
    bridge.enabled.mockReturnValue(false);
    setBridge(bridge);
    await show();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    await act(async () => { toggle().click(); });
    expect(bridge.set).toHaveBeenLastCalledWith(true);
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    await act(async () => { toggle().click(); });
    expect(bridge.set).toHaveBeenLastCalledWith(false);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });

  it("puts the switch back when the app cannot save it", async () => {
    bridge.set.mockRejectedValue(new Error("no"));
    setBridge(bridge);
    await show();
    await act(async () => { toggle().click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });

  it("names no vendor, host or mechanism in its text", async () => {
    setBridge(bridge);
    await show();
    expect(host.textContent).not.toMatch(/sentry|endpoint|dsn|tunnel|server|https?:\/\//i);
  });
});
