// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { ApprovalHistorySetting } from "./ApprovalHistorySetting";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), decisions: { retentionDays: 180, fixed: false } as { retentionDays: number; fixed?: boolean } | undefined }));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { config: { decisions: fixture.decisions } }, dispatch: fixture.dispatch }),
}));

let host: HTMLDivElement;
let root: Root;
const field = () => host.querySelector<HTMLInputElement>("#approval-history-days")!;
const type = (value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field(), value);
  flushSync(() => field().dispatchEvent(new Event("input", { bubbles: true })));
  flushSync(() => field().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
};

beforeEach(() => {
  vi.clearAllMocks();
  fixture.decisions = { retentionDays: 180, fixed: false };
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});
const render = () => flushSync(() => root.render(createElement(ApprovalHistorySetting)));

describe("ApprovalHistorySetting", () => {
  it("shows the saved days under a labelled input", () => {
    render();
    expect(field().value).toBe("180");
    expect(field().getAttribute("aria-label")).toBe("Days to keep");
    expect(host.textContent).toContain("Approval history");
  });

  it("saves a changed number of days", async () => {
    fixture.api.mockResolvedValue({ decisions: { retentionDays: 90 } });
    render();
    type("90");
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalled());
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decisions: { retentionDays: 90 } }) });
  });

  it("does not save a number outside the range", () => {
    render();
    type("0");
    expect(fixture.api).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("from 1 to 3650");
  });

  it("shows a failed save inline", async () => {
    fixture.api.mockRejectedValue(new Error("Disk is read-only"));
    render();
    type("30");
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toBe("Disk is read-only"));
  });

  it("disables the input and says why when the days are set outside the app", () => {
    fixture.decisions = { retentionDays: 30, fixed: true };
    render();
    expect(field().disabled).toBe(true);
    expect(host.textContent).toContain("This is set outside the app, so it can't be changed here.");
  });

  it("renders nothing when the server does not report the days", () => {
    fixture.decisions = undefined;
    render();
    expect(host.textContent).toBe("");
  });
});
