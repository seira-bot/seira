// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ admin: true as boolean | null, services: {} as Record<string, unknown>, config: null as unknown }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: fixture.config } }) }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));
vi.mock("@/lib/connected-apps", () => ({ preloadConnectedApps: vi.fn(async () => ({ services: fixture.services, authoritative: true })) }));
const { ImportAppChoices } = await import("./ImportAppChoices");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const apps = [{ slug: "gmail", label: "Gmail" }, { slug: "slack", label: "Slack" }];
let host: HTMLDivElement;
let root: Root;
let chosen: string[] = [];

function Harness() {
  const [value, setValue] = useState<string[]>([]);
  chosen = value;
  return createElement(ImportAppChoices, { apps, chosen: value, onChange: setValue });
}
const render = async () => {
  await act(async () => root.render(createElement(Harness)));
  await act(async () => { await Promise.resolve(); });
};
const rows = () => Array.from(host.querySelectorAll<HTMLElement>("[role=switch]"));

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fixture.admin = true;
  fixture.config = null;
  fixture.services = { gmail: { connected: true } };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("offers a choice only for a connected app, off by default, and records it", async () => {
  await render();
  expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual(["Let the new bots use Gmail"]);
  expect(rows()[0]!.getAttribute("aria-checked")).toBe("false");
  await act(async () => rows()[0]!.click());
  expect(chosen).toEqual(["gmail"]);
  await act(async () => rows()[0]!.click());
  expect(chosen).toEqual([]);
});

it("shows nothing to a person who is not an owner or admin, or for an app the organization refuses", async () => {
  fixture.admin = false;
  await render();
  expect(rows()).toEqual([]);
  fixture.admin = true;
  fixture.config = { managedPolicy: { apps: { allowAll: false, allowlist: ["slack"] } } };
  await render();
  expect(rows()).toEqual([]);
});
