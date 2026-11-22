// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddAccountHint, ConnectorAccountRows } from "./ConnectorAccountRows";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { flushSync(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const rows = (accounts: Array<{ id: string; status: string; alias?: string; displayName?: string; duplicateOf?: string }>) =>
  flushSync(() => root.render(createElement(ConnectorAccountRows, { accounts, service: "GitHub", busy: false, onReconnect: () => {}, onDisconnect: () => {} })));

describe("account rows", () => {
  it("shows label, provider name and fallback, and no account id anywhere", () => {
    rows([
      { id: "ca_secret1", status: "ACTIVE", alias: "work", displayName: "octo" },
      { id: "ca_secret2", status: "ACTIVE", displayName: "hubot" },
      { id: "ca_secret3", status: "ACTIVE" },
    ]);
    const text = host.textContent ?? "";
    expect(text).toContain("work · octo");
    expect(text).toContain("hubot");
    expect(text).toContain("Account 3");
    expect(host.innerHTML).not.toContain("ca_secret");
    expect(host.querySelector('[aria-label="Disconnect Account 3 from GitHub"]')).toBeTruthy();
  });
  it("says a duplicate is the same account as the original", () => {
    rows([
      { id: "a", status: "ACTIVE", alias: "work" },
      { id: "b", status: "ACTIVE", displayName: "octo", duplicateOf: "a" },
    ]);
    expect(host.textContent).toContain("Same account as work.");
  });
});

describe("add account hint", () => {
  it("names the fresh window on desktop GitHub", () => {
    vi.stubGlobal("window", Object.assign(Object.create(window), { ogb: { openCleanSignInPage: () => Promise.resolve(true) } }));
    flushSync(() => root.render(createElement(AddAccountHint, { slug: "github" })));
    expect(host.textContent).toContain("fresh sign-in window");
  });
  it("tells the browser story for Gmail, and for GitHub without the bridge", () => {
    flushSync(() => root.render(createElement(AddAccountHint, { slug: "gmail" })));
    expect(host.textContent).toContain("already signed in to your browser");
    flushSync(() => root.render(createElement(AddAccountHint, { slug: "github" })));
    expect(host.textContent).toContain("already signed in to your browser");
  });
});
