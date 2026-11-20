// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { setLocale, t } from "@/lib/i18n";
import type { Message } from "@/state/store";

const api = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", () => ({
  api,
  useStore: () => { throw new Error("outside the app"); },
}));
import { ConnectorCard } from "./ConnectorCard";

const AUTH_URL = "https://auth.example.test/authorize?client_id=seira&state=s1";
const AUTHORIZE = ["/api/bots/atlas/connector-cards/m1/authorize", { method: "POST", body: JSON.stringify({ threadId: "thread" }) }];

let host: HTMLDivElement;
let root: Root;
let open: Mock<(...args: unknown[]) => unknown>;

const render = () => flushSync(() => root.render(createElement(ConnectorCard, {
  botId: "atlas",
  threadId: "thread",
  message: {
    id: "m1",
    role: "bot",
    kind: "connector",
    at: 1,
    connector: { source: "mcp", slug: "growc-team", label: "Growc Team", description: "Team tools", status: "required", resumeKey: "resume1" } as NonNullable<Message["connector"]>,
  },
})));
const signInButton = () => {
  const button = [...host.querySelectorAll("button")].find((each) => each.textContent === "Sign in");
  if (!button) throw new Error("no Sign in button");
  return button;
};
const link = () => host.querySelector("a")?.getAttribute("href") ?? null;
const text = (role: "alert" | "status") => host.querySelector(`[role="${role}"]`)?.textContent ?? null;

async function signIn() {
  render();
  const button = signInButton();
  button.click();
  await vi.waitFor(() => expect(link()).toBe(AUTH_URL));
  await vi.waitFor(() => expect(button.disabled).toBe(false));
}

beforeEach(() => {
  setLocale("en");
  api.mockResolvedValue({ url: AUTH_URL });
  open = vi.fn<(...args: unknown[]) => unknown>(() => null);
  vi.spyOn(window, "open").mockImplementation(open as unknown as typeof window.open);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  delete (window as { ogb?: unknown }).ogb;
  vi.restoreAllMocks();
  api.mockReset();
});

describe("ConnectorCard Sign in on a desktop page from another server", () => {
  it("sends the sign-in request, hands the page to the app window and offers the link", async () => {
    (window as { ogb?: unknown }).ogb = { platform: "win32" };
    await signIn();
    expect(api).toHaveBeenCalledWith(...AUTHORIZE);
    expect(open.mock.calls).toEqual([[AUTH_URL, "_blank", "noopener,noreferrer"]]);
    expect(text("status")).toBe(t("connectors.card.linkIfNotOpened"));
    expect(text("alert")).toBeNull();
  });

  it("shows the pop-up note with the link when the page cannot hand the link over", async () => {
    (window as { ogb?: unknown }).ogb = { platform: "win32" };
    open.mockImplementation(() => { throw new Error("refused"); });
    await signIn();
    expect(api).toHaveBeenCalledWith(...AUTHORIZE);
    expect(text("alert")).toBe(t("connectors.card.popupBlocked"));
    expect(text("status")).toBeNull();
  });
});

describe("ConnectorCard Sign in on this computer's page and on the web", () => {
  it("opens the page through the desktop app, as before", async () => {
    const openExternal = vi.fn(async () => true);
    (window as { ogb?: unknown }).ogb = { platform: "win32", openExternal };
    await signIn();
    expect(api).toHaveBeenCalledWith(...AUTHORIZE);
    expect(openExternal).toHaveBeenCalledWith(AUTH_URL);
    expect(open).not.toHaveBeenCalled();
    expect(text("status")).toBeNull();
    expect(text("alert")).toBeNull();
  });

  it("fills the tab the web page reserved in the click, as before", async () => {
    const page = { opener: {}, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
    open.mockReturnValue(page);
    await signIn();
    expect(open.mock.calls).toEqual([["", "_blank"]]);
    expect(page.location.replace).toHaveBeenCalledWith(AUTH_URL);
    expect(text("status")).toBeNull();
    expect(text("alert")).toBeNull();
  });

  it("shows the pop-up note with the link when the web page's tab was blocked, as before", async () => {
    await signIn();
    expect(open.mock.calls).toEqual([["", "_blank"]]);
    expect(text("alert")).toBe(t("connectors.card.popupBlocked"));
    expect(text("status")).toBeNull();
  });
});
