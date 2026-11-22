// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installCrashReports, pageName, reportPage, reportPageBoundary, resetCrashReportsForTest } from "./crash-reports";

const bridge = (available = true) => ({ available, enabled: vi.fn(() => true), set: vi.fn(async () => undefined), report: vi.fn(), page: vi.fn() });
let current: ReturnType<typeof bridge>;
const useBridge = (value: unknown) => { (window as unknown as { ogb: unknown }).ogb = value === undefined ? {} : { crashReports: value }; };
const fireError = (error: unknown) => window.dispatchEvent(Object.assign(new Event("error"), { error, message: "canary-event-message", filename: "http://127.0.0.1:1/x.js?secret=1" }));
const fireRejection = (reason: unknown) => window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason }));

beforeEach(() => { resetCrashReportsForTest(); current = bridge(); });
afterEach(() => { delete (window as unknown as { ogb?: unknown }).ogb; });

describe("installCrashReports", () => {
  it("sends an uncaught error and an unhandled rejection through the bridge with the page (AC-14)", () => {
    useBridge(current);
    installCrashReports();
    reportPage("settings");
    const error = new TypeError("boom");
    error.stack = "TypeError: boom\n    at run (http://127.0.0.1:5173/assets/app.js?token=abc#frag:10:5)\nnoise line";
    fireError(error);
    fireRejection(new RangeError("later"));
    expect(current.report).toHaveBeenCalledTimes(2);
    const [first] = current.report.mock.calls[0]!;
    expect(first).toMatchObject({ kind: "renderer-error", errorName: "TypeError", message: "boom", page: "settings" });
    expect(first.stack).toBe("    at run (http://127.0.0.1:5173/assets/app.js:10:5)");
    expect(current.report.mock.calls[1]![0]).toMatchObject({ kind: "renderer-rejection", errorName: "RangeError" });
  });

  it("installs no listener when there is no bridge or the build cannot send reports (AC-16)", () => {
    useBridge(undefined);
    installCrashReports();
    fireError(new Error("x"));
    useBridge(bridge(false));
    installCrashReports();
    fireError(new Error("y"));
    expect(current.report).not.toHaveBeenCalled();
  });

  it("sends no text of a thrown value that is not an Error, and no event message or file address", () => {
    useBridge(current);
    installCrashReports();
    fireRejection("canary user text");
    fireError(null);
    const sent = JSON.stringify(current.report.mock.calls);
    expect(sent).not.toContain("canary");
    expect(sent).not.toContain("secret");
    expect(sent).not.toContain("127.0.0.1");
  });

  it("sends one report for a repeated error and at most 20 reports for a page load", () => {
    useBridge(current);
    installCrashReports();
    const same = new Error("same");
    for (let i = 0; i < 5; i++) fireError(same);
    expect(current.report).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 40; i++) { const error = new Error(`e${i}`); error.stack = `Error\n    at f${i} (app.js:1:1)`; fireError(error); }
    expect(current.report).toHaveBeenCalledTimes(20);
  });

  it("installs its listeners once", () => {
    useBridge(current);
    installCrashReports();
    installCrashReports();
    fireError(new Error("once"));
    expect(current.report).toHaveBeenCalledTimes(1);
  });
});

describe("reportPageBoundary", () => {
  it("sends a page-boundary report, and nothing without a bridge", () => {
    useBridge(undefined);
    reportPageBoundary(new Error("x"));
    useBridge(current);
    reportPageBoundary(new Error("caught"));
    expect(current.report).toHaveBeenCalledTimes(1);
    expect(current.report.mock.calls[0]![0]).toMatchObject({ kind: "page-boundary", errorName: "Error", message: "caught" });
  });
});

describe("pages", () => {
  it("tells the main process once for each change of the visible page", () => {
    useBridge(current);
    reportPage("chat");
    reportPage("chat");
    reportPage("settings");
    reportPage("settings");
    reportPage("chat");
    expect(current.page.mock.calls.map((call) => call[0])).toEqual(["chat", "settings", "chat"]);
  });

  it("names the page from the view with the fixed names", () => {
    expect(pageName({ activeView: "chat", settingsOpen: false, firstRun: false })).toBe("chat");
    expect(pageName({ activeView: "chat", settingsOpen: true, firstRun: false })).toBe("settings");
    expect(pageName({ activeView: "chat", settingsOpen: false, firstRun: true })).toBe("onboarding");
    expect(pageName({ activeView: "routines", settingsOpen: false, firstRun: false })).toBe("other");
  });
});
