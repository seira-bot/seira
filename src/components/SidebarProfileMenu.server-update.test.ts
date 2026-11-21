import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ServerUpdateCheck } from "@/lib/server-update";

// React's hooks are replayed by hand.
const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], check: null as unknown, status: null as unknown, dispatch: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = initial; return [f.values[index], (next: unknown) => { f.values[index] = next; }]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
vi.mock("@/state/store", () => ({
  api: vi.fn(async (route: string) => (route === "/api/updates/server" ? f.status : f.check)),
  useStore: () => ({ state: { config: {} }, dispatch: f.dispatch }),
}));
import { simpleUpdateTop, useServerUpdateItem } from "./SidebarProfileMenu";

// The server the window shows, on 0.1.116 from npm, while 0.1.127 is out.
const npmServer: ServerUpdateCheck = {
  current: "0.1.116", install: "npm", latest: "0.1.127", available: true, command: "npm install -g @seira-bot/seira@latest", restart: true,
};
let entry: ReturnType<typeof useServerUpdateItem>;
function render() {
  f.index = 0; f.effects = [];
  renderToStaticMarkup(createElement(() => { entry = useServerUpdateItem(true); return null; }));
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
async function checkedRow(page: object) {
  f.values = [];
  vi.stubGlobal("window", page);
  render();
  for (const effect of f.effects) effect();
  await flush();
  render();
  entry!.item.onSelect?.();
  await flush();
  render();
  return { label: entry!.item.label, subtitle: entry!.item.subtitle, attention: entry!.item.attention };
}

beforeEach(() => { f.check = npmServer; f.status = { mode: "command", current: "0.1.116", available: true, activeTurns: 0 }; f.dispatch.mockReset(); });
afterEach(() => vi.unstubAllGlobals());

it("in the app on another server, says the update is that server's, for whoever runs it", async () => {
  const workspaces = { state: vi.fn(async () => ({ local: false, name: "Office Mac", origin: "https://bots.example.test" })) };
  expect(await checkedRow({ ogb: { app: { version: "0.1.127", ownPage: false }, workspaces }, location: { host: "bots.example.test" } })).toEqual({
    label: "Office Mac can update to 0.1.127",
    subtitle: "Whoever runs that server updates it with: npm install -g @seira-bot/seira@latest, then restarts it",
    attention: true,
  });
});

it("names the server by its address until the app says its saved name", async () => {
  const workspaces = { state: vi.fn(() => new Promise(() => {})) };
  expect((await checkedRow({ ogb: { app: { version: "0.1.127", ownPage: false }, workspaces }, location: { host: "bots.example.test" } })).label)
    .toBe("bots.example.test can update to 0.1.127");
});

it("keeps today's row in a browser on that server and in the app on this computer", async () => {
  const today = {
    label: "Version 0.1.127 available (release notes)",
    subtitle: "Update with: npm install -g @seira-bot/seira@latest, then restart the app",
    attention: true,
  };
  expect(await checkedRow({ location: { host: "bots.example.test" } })).toEqual(today);
  expect(await checkedRow({ ogb: { app: { version: "0.1.127", ownPage: true } }, location: { host: "127.0.0.1:8799" } })).toEqual(today);
});

it("raises an npm server's release as available, with how to update it, in Settings", async () => {
  await checkedRow({ location: { host: "bots.example.test" } });
  const top = simpleUpdateTop(entry);
  expect(top).toMatchObject({ label: "Server update available", action: "How to update" });
  top!.onSelect!();
  expect(f.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "overview" });
});

it("raises a Docker server's release as ready to install when the server has its own Update server button", async () => {
  f.check = { current: "0.1.116", install: "docker", latest: "0.1.127", available: true, releaseUrl: "https://example.test/release" };
  f.status = { mode: "button", current: "0.1.116", available: true, activeTurns: 0 };
  await checkedRow({ location: { host: "bots.example.test" } });
  const top = simpleUpdateTop(entry);
  expect(top).toMatchObject({ label: "Update ready", action: "Install" });
  top!.onSelect!();
  expect(f.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "overview" });
});

it("keeps the release page on this computer's own page, where Settings has no server update row", async () => {
  await checkedRow({ ogb: { companion: {}, app: { version: "0.1.127", ownPage: true } }, location: { host: "127.0.0.1:8799" } });
  expect(simpleUpdateTop(entry)?.onSelect).toBeUndefined();
});

it("treats a member, whom the server refuses its button state, as one who cannot install", async () => {
  f.status = undefined;
  const refusal = Object.assign(new Error("this session lacks the admin scope"), { status: 403 });
  const { api } = await import("@/state/store");
  vi.mocked(api).mockImplementationOnce(async () => f.check).mockImplementationOnce(async () => { throw refusal; });
  f.values = [];
  vi.stubGlobal("window", { location: { host: "bots.example.test" } });
  render();
  entry!.item.onSelect?.();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  render();
  expect(simpleUpdateTop(entry)).toMatchObject({ label: "Server update available", action: "How to update" });
});
