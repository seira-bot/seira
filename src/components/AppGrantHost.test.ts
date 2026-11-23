// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({
  state: { bots: [] as unknown[], instances: [] as unknown[], config: null as unknown },
  dispatch: vi.fn(),
  admin: true as boolean | null,
}));

vi.mock("@/state/store", () => ({ useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }) }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));

import { announceAppConnected } from "@/lib/app-connected";
import { AppGrantHost, AppGrantNotice, showAppGrantNotice } from "./AppGrantPrompt";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const claude = { instanceId: "claude", capabilities: { composioMcp: true } } as unknown as InstanceInfo;
const bot = (id: string, extra: Partial<Bot> = {}) => ({ id, name: id, color: "blue", modelSelection: { instanceId: "claude", model: "m" }, ...extra }) as unknown as Bot;
const toast = () => document.body.querySelector<HTMLElement>("[data-access-toast]");
const writes = () => fixture.dispatch.mock.calls.map(([action]) => action).filter((action) => action.type === "updateBot");

let host: HTMLDivElement;
let root: Root;
const connected = (slug = "gmail", app = "Gmail") => act(async () => announceAppConnected(slug, app));

beforeEach(async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fixture.state = { bots: [], instances: [claude], config: null };
  fixture.dispatch.mockReset();
  fixture.admin = true;
  showAppGrantNotice(null);
  await act(async () => root.render(createElement(Fragment, null, createElement(AppGrantHost), createElement(AppGrantNotice))));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("an app connected from a chat card", () => {
  it("is given to a bot with its own app list and says every bot can use it", async () => {
    fixture.state.bots = [bot("scout", { connectorScopes: { apps: { slack: "read" } } }), bot("free")];
    await connected();
    expect(writes()).toEqual([{ type: "updateBot", botId: "scout", patch: { connectorScopes: { apps: { slack: "read", gmail: "write" } } } }]);
    expect(toast()?.textContent).toBe("Your bots can now use Gmail.Change");
  });

  it("leaves a bot with apps off alone and counts it", async () => {
    fixture.state.bots = [bot("free"), bot("off", { composio: false, connectorTools: {} })];
    await connected();
    expect(writes()).toEqual([]);
    expect(toast()?.textContent).toBe("1 bot can't use Gmail yet.Change");
  });

  it("counts several bots, and Change opens the Apps page", async () => {
    fixture.state.bots = [bot("a", { composio: false }), bot("b", { composio: false }), bot("c")];
    await connected();
    expect(toast()?.textContent).toBe("2 bots can't use Gmail yet.Change");
    await act(async () => toast()!.querySelector("button")!.click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "togglePlugins", open: true, surface: "apps" });
  });

  it("does nothing for a person who is not an owner or admin", async () => {
    fixture.admin = false;
    fixture.state.bots = [bot("scout", { connectorScopes: { apps: {} } })];
    await connected();
    expect(writes()).toEqual([]);
    expect(toast()).toBeNull();
  });

  it("writes nothing for an app the organization's rules refuse", async () => {
    fixture.state.config = { managedPolicy: { organizationName: "Acme", apps: { allowAll: false, allowlist: ["slack"] } } };
    fixture.state.bots = [bot("scout", { connectorScopes: { apps: {} } })];
    await connected();
    expect(writes()).toEqual([]);
    expect(toast()).toBeNull();
  });
});
