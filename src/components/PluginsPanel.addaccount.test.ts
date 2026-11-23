// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
}));

vi.mock("@/state/store", () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/connectors/catalog") {
      return { cards: [{ slug: "apollo", label: "Apollo", blurb: "leads", logo: null, domain: null }], source: "api", configured: true, mode: "self-hosted" };
    }
    if (path.startsWith("/api/connectors?services=")) return { services: fixture.services };
    if (init?.method === "DELETE") return {};
    if (path.endsWith("/authorize")) return { url: "https://backend.composio.dev/api/v3/s/abc" };
    throw new Error(`unexpected ${path}`);
  }),
  useStore: () => ({
    state: { pluginsSurface: "apps", bots: [], instances: [], config: null },
    dispatch: vi.fn(),
  }),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/lib/connected-apps", () => ({
  preloadConnectedApps: vi.fn(async () => ({ services: fixture.services, authoritative: true })),
  connectorStatusMemory: () => null,
  rememberConnectorStatus: () => {},
}));
vi.mock("@/lib/connected-apps-cache", () => ({ readCachedInventory: () => null, writeCachedInventory: () => {} }));
const opened = vi.hoisted(() => [] as Array<[string, unknown]>);
vi.mock("@/lib/connector-oauth", () => ({
  reserveConnectionPage: () => ({ open: async (url: string, options?: unknown) => { opened.push([url, options]); return true; }, cancel: () => {} }),
  reusableConnectionUrl: () => null,
}));
vi.mock("@/lib/product-events", () => ({ connectorConnect: vi.fn() }));
vi.mock("./McpServersPanel", () => ({ McpServersPanel: () => null }));
vi.mock("./XCard", () => ({ X_CARD_SEARCH: "x", XCard: () => null }));
vi.mock("./EmailCard", () => ({ EmailCard: () => null }));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));

import { api } from "@/state/store";
const { PluginsPanel } = await import("./PluginsPanel");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const open = async () => {
  await act(async () => root.render(createElement(PluginsPanel)));
  await flush();
};
const tile = () => host.querySelector<HTMLElement>('[data-app-tile="apollo"]')!;
const byLabel = (scope: ParentNode, label: string) =>
  Array.from(scope.querySelectorAll("button")).find((candidate) => candidate.textContent === label || candidate.getAttribute("aria-label") === label);
const deletes = () => vi.mocked(api).mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === "DELETE");

const tick = (ms = 10) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const addAccount = async (alias: string) => {
  vi.useFakeTimers();
  await act(async () => { byLabel(tile(), "Add account")!.click(); });
  const input = tile().querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, alias);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { tile().querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await tick();
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  opened.length = 0;
  fixture.services = { apollo: { connected: true, accounts: [{ id: "ca_old", alias: "work", displayName: "octo", status: "ACTIVE" }] } };
  vi.mocked(api).mockClear();
});
afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  host.remove();
});

describe("adding a second account", () => {
  it("removes a new copy of the same account once and says so", async () => {
    await open();
    expect(tile().textContent).toContain("work · octo");
    expect(tile().innerHTML).not.toContain("ca_old");
    await addAccount("second");
    expect(opened).toEqual([["https://backend.composio.dev/api/v3/s/abc", { cleanWindow: false }]]);
    fixture.services = { apollo: { connected: true, accounts: [
      { id: "ca_old", alias: "work", displayName: "octo", status: "ACTIVE" },
      { id: "ca_new", alias: "second", displayName: "octo", status: "ACTIVE", duplicateOf: "ca_old" },
    ] } };
    await tick(5_100);
    expect(deletes()).toEqual([["/api/connectors/apollo/accounts/ca_new", { method: "DELETE" }]]);
    expect(host.textContent).toContain("This account is already connected. Sign in with a different account to add another one.");
  });

  it("keeps a different account", async () => {
    await open();
    await addAccount("second");
    fixture.services = { apollo: { connected: true, accounts: [
      { id: "ca_old", alias: "work", displayName: "octo", status: "ACTIVE" },
      { id: "ca_new", alias: "second", displayName: "hubot", status: "ACTIVE" },
    ] } };
    await tick(5_100);
    expect(deletes()).toEqual([]);
  });

  it("shows the browser hint in the form", async () => {
    await open();
    await act(async () => { byLabel(tile(), "Add account")!.click(); });
    expect(tile().textContent).toContain("already signed in to your browser");
  });
});
