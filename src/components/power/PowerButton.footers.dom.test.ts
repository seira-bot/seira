// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { fixture, stub } = vi.hoisted(() => ({ fixture: { advanced: false }, stub: () => () => null }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: {}, bots: [], groups: [] }, dispatch: vi.fn() }) }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => null }));
vi.mock("../AccountMove", () => ({ AccountMoveStatus: stub(), useAccountMoveLine: () => ({ kind: null, place: null, retry: () => {} }) }));
vi.mock("../CloudRoomCard", () => ({ CloudRoomCard: stub() }));
vi.mock("../CloudUsageMeter", () => ({ CloudUsageCard: stub() }));
vi.mock("../DesktopWorkspaceSwitcher", () => ({ endCloudHowTo: () => {}, useWorkspacePlace: () => ({ error: null, waking: null }) }));
vi.mock("../SidebarConnectApps", () => ({ SidebarConnectApps: stub() }));
vi.mock("../SidebarFooterNav", () => ({ SidebarBottomButtons: stub(), SidebarFooterNav: stub() }));
vi.mock("../SidebarPhoneButton", () => ({ phoneSettingsAction: () => ({}), SidebarPhoneButton: stub() }));
vi.mock("../SidebarProfileMenu", () => ({ SidebarProfileMenu: stub(), useSimpleAccount: () => null }));
vi.mock("../EngineUsage", () => ({ SidebarUsageRing: stub() }));
vi.mock("../UpdateIndicator", () => ({ UpdateIndicator: stub() }));

import { SidebarFooter } from "../SidebarFooter";
import { SimpleRailFooter } from "../SidebarSimpleRail";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  (window as unknown as { ogb: unknown }).ogb = { relaunch: () => Promise.resolve() };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete (window as unknown as { ogb?: unknown }).ogb;
  vi.unstubAllGlobals();
});

const count = () => container.querySelectorAll("[data-power-button]").length;

it.each([
  ["the simple footer", { density: "wide", simple: true }],
  ["the advanced wide footer", { density: "wide" }],
  ["the advanced icon footer", { density: "icons" }],
])("shows the power button in %s", async (_name, props) => {
  await act(async () => root.render(createElement(SidebarFooter, { toolsCollapsed: false, ...props } as never)));
  expect(count()).toBe(1);
});

it("shows the power button in the simple rail footer", async () => {
  await act(async () => root.render(createElement(SimpleRailFooter, {})));
  expect(count()).toBe(1);
});

it("shows no power button outside the desktop app", async () => {
  delete (window as unknown as { ogb?: unknown }).ogb;
  await act(async () => root.render(createElement(SidebarFooter, { toolsCollapsed: false, density: "wide", simple: true } as never)));
  expect(count()).toBe(0);
});
