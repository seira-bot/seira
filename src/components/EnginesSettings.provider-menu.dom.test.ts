// @vitest-environment happy-dom
// The provider menu on a Settings → AI provider row: Sign out, Remove key, Hide, and Move and hide with Undo.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import { setLocale, t } from "@/lib/i18n";
import { rememberProviderOff } from "@/lib/provider-off";

type Call = { method: string; path: string; body?: unknown };
const server = vi.hoisted(() => ({
  all: [] as InstanceInfo[], hidden: new Set<string>(), calls: [] as Call[], persisted: [] as Array<{ id: string; patch: Record<string, unknown> }>, refuse: new Set<string>(), refuseHide: null as unknown[] | null,
}));
const fixture = vi.hoisted(() => ({ state: { instances: [] as InstanceInfo[], bots: [] as Bot[], config: {} as Record<string, unknown> } }));
vi.mock("@/state/store", async (original) => {
  const visible = () => server.all.filter((instance) => !server.hidden.has(instance.instanceId));
  const real = await original<typeof import("@/state/store")>();
  const { ApiError } = real;
  return {
    ...real,
    desktopApprovalBridge: () => undefined,
    persistBotUpdate: async (id: string, patch: Record<string, unknown>, _signal: unknown, _api: unknown, _bridge: unknown, bot: Bot) => {
      if (server.refuse.has(id)) throw new Error("This bot is working. Try again when it is done.");
      server.persisted.push({ id, patch });
      return { ...bot, ...patch };
    },
    useStore: () => ({
      state: fixture.state,
      dispatch: (action: { type: string; instances?: InstanceInfo[]; bot?: Bot }) => {
        if (action.type === "instances" && action.instances) fixture.state = { ...fixture.state, instances: action.instances };
        if (action.type === "botPatched" && action.bot) fixture.state = { ...fixture.state, bots: fixture.state.bots.map((bot) => bot.id === action.bot!.id ? action.bot! : bot) };
      },
      refreshInstances: async () => { fixture.state = { ...fixture.state, instances: visible() }; }, refreshModels: async () => {},
    }),
    api: async (path: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      server.calls.push({ method, path, ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
      if (path === "/api/instances/hidden") {
        return { instances: server.all.filter((instance) => server.hidden.has(instance.instanceId)).map(({ instanceId, driverKind, displayName }) => ({ instanceId, driverKind, displayName })) };
      }
      const patch = /^\/api\/instances\/([\w.-]+)$/.exec(path);
      if (patch && method === "PATCH") {
        const { hidden, force } = JSON.parse(init!.body!) as { hidden?: boolean; force?: boolean };
        if (hidden === true && server.refuseHide && !force) throw new ApiError("Bots or conversations still use this AI.", 409, { uses: server.refuseHide });
        if (hidden === true) server.hidden.add(patch[1]!);
        if (hidden === false) server.hidden.delete(patch[1]!);
        return { instances: visible() };
      }
      return {};
    },
  };
});
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
const { EnginesSettings } = await import("./EnginesSettings");
const { ProviderMenu } = await import("./ProviderMenu");

const ready = (instanceId: string, displayName: string, extra: Partial<InstanceInfo> = {}): InstanceInfo => ({
  instanceId, driverKind: "kimiAgent", displayName, cliDefault: instanceId, access: "subscription",
  snapshot: { state: "available", authenticated: true, version: "1" }, models: { default: `${instanceId}-model`, options: [{ id: `${instanceId}-model`, label: "M" }] },
  ...extra,
});
const kimi = ready("kimi", "Kimi");
const hermes = ready("hermes", "Hermes");
const bot = (id: string, on: string, extra: Partial<Bot> = {}): Bot => ({ id, name: id, modelSelection: { instanceId: on, model: `${on}-model` }, ...extra } as Bot);

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  server.all = [kimi, hermes];
  server.hidden = new Set();
  server.calls = [];
  server.persisted = [];
  server.refuse = new Set();
  server.refuseHide = null;
  rememberProviderOff(null);
  fixture.state = { instances: [...server.all], bots: [], config: {} };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

const render = async () => {
  await act(async () => { root.render(createElement(EnginesSettings, { simple: true, more: { id: "ai-more", open: true, onToggle: () => {} } })); });
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};
const click = async (target: Element | null | undefined) => {
  expect(target).toBeTruthy();
  await act(async () => { (target as HTMLElement).click(); });
  await render();
};
const menu = (instanceId: string) => container.querySelector(`[data-provider-menu="${instanceId}"]`);
const item = (selector: string) => document.body.querySelector(`[data-provider-floating] ${selector}`);
const openMenu = async (instanceId: string) => {
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await click(menu(instanceId)?.querySelector('button[aria-haspopup="menu"]'));
};
const status = () => container.querySelector("[data-provider-off-status]")?.textContent ?? "";
const patches = () => server.calls.filter((call) => call.method === "PATCH");

describe("Hide and Move and hide", () => {
  it("shows who uses the provider, and offers the move instead of Hide", async () => {
    fixture.state = { ...fixture.state, bots: [bot("a", "kimi"), bot("b", "kimi")] };
    await render();
    await openMenu("kimi");
    expect(item("[data-provider-used]")?.textContent).toBe(t("provider.usedBy", { count: "2" }));
    expect(item("[data-provider-move]")?.textContent).toBe(t("provider.moveAndHide", { count: "2", target: "Hermes" }));
    expect(item("[data-provider-hide]")).toBeNull();
  });

  it("moves each bot's model and backup, follows the conversations, then hides", async () => {
    fixture.state = { ...fixture.state, bots: [bot("a", "kimi"), bot("b", "hermes", { fallback: [{ instanceId: "kimi", model: "m" }] })] };
    await render();
    await openMenu("kimi");
    await click(item("[data-provider-move]"));
    expect(server.persisted).toEqual([
      { id: "a", patch: { keepThreadModels: true, modelSelection: { instanceId: "hermes", model: "hermes-model" } } },
      { id: "b", patch: { keepThreadModels: true, fallback: [] } },
    ]);
    expect(server.calls.filter((call) => call.path.endsWith("/threads/follow-model")).map((call) => call.path)).toEqual([
      "/api/bots/a/threads/follow-model", "/api/bots/b/threads/follow-model",
    ]);
    expect(patches()).toEqual([{ method: "PATCH", path: "/api/instances/kimi", body: { hidden: true } }]);
    const order = server.calls.map((call) => call.path);
    expect(order.lastIndexOf("/api/bots/b/threads/follow-model")).toBeLessThan(order.indexOf("/api/instances/kimi"));
    expect(status()).toContain(t("provider.movedHidden", { name: "Kimi", count: "2", target: "Hermes" }));
  });

  it("keeps the provider and says which bot stays when a bot cannot move", async () => {
    server.refuse.add("b");
    fixture.state = { ...fixture.state, bots: [bot("a", "kimi"), bot("b", "kimi")] };
    await render();
    await openMenu("kimi");
    await click(item("[data-provider-move]"));
    expect(server.persisted.map((one) => one.id)).toEqual(["a"]);
    expect(patches()).toEqual([]);
    expect(status()).toContain(t("provider.partial", { moved: "1", stayed: "1", name: "Kimi" }));
    expect(container.querySelector('[data-simple-engine="kimi"]')).toBeTruthy();
  });

  it("keeps a working bot where it is, and does not hide", async () => {
    fixture.state = { ...fixture.state, bots: [bot("a", "kimi", { busy: true })] };
    await render();
    await openMenu("kimi");
    await click(item("[data-provider-move]"));
    expect(server.persisted).toEqual([]);
    expect(patches()).toEqual([]);
    expect(status()).toContain(t("provider.partial", { moved: "0", stayed: "1", name: "Kimi" }));
  });

  it("says to set up another AI first when none is ready, and offers no move", async () => {
    server.all = [kimi, { ...hermes, snapshot: { state: "available", authenticated: false } }];
    fixture.state = { instances: [...server.all], bots: [bot("a", "kimi")], config: {} };
    await render();
    await openMenu("kimi");
    expect(item("[data-provider-no-target]")?.textContent).toBe(t("provider.noTarget"));
    expect(item("[data-provider-move]")).toBeNull();
    expect(item("[data-provider-hide]")).toBeNull();
  });

  it("puts every bot and the provider back with Undo", async () => {
    fixture.state = { ...fixture.state, bots: [bot("a", "kimi", { fallback: [{ instanceId: "hermes", model: "x" }] })] };
    await render();
    await openMenu("kimi");
    await click(item("[data-provider-move]"));
    expect(server.hidden.has("kimi")).toBe(true);
    server.persisted = [];
    server.calls = [];
    await click(container.querySelector("[data-provider-undo]"));
    expect(server.calls.filter((call) => call.path.endsWith("/threads/follow-model")).map((call) => call.path)).toEqual(["/api/bots/a/threads/follow-model"]);
    expect(server.hidden.has("kimi")).toBe(false);
    expect(server.persisted).toEqual([{ id: "a", patch: { modelSelection: { instanceId: "kimi", model: "kimi-model" }, fallback: [{ instanceId: "hermes", model: "x" }] } }]);
    expect(container.querySelector("[data-provider-off-status]")).toBeNull();
    expect(container.querySelector('[data-simple-engine="kimi"]')).toBeTruthy();
  });

  it("closes the result with its close button", async () => {
    await render();
    await openMenu("kimi");
    await click(item("[data-provider-hide]"));
    expect(status()).toContain(t("provider.hidden", { name: "Kimi" }));
    await click(container.querySelector('[data-provider-off-status] button[aria-label="Close"]'));
    expect(container.querySelector("[data-provider-off-status]")).toBeNull();
  });
});

describe("Sign out and Remove key", () => {
  it("offers Sign out where the provider can sign out, and not where it cannot", async () => {
    server.all = [ready("kimi", "Kimi", { authentication: { method: "device-code", signOut: true } }), hermes];
    fixture.state = { instances: [...server.all], bots: [], config: {} };
    await render();
    await openMenu("kimi");
    expect(item("[data-provider-sign-out]")?.textContent).toBe(t("accounts.signOut"));
    await openMenu("hermes");
    expect(item("[data-provider-sign-out]")).toBeNull();
  });

  it("tells how to sign out in the provider's own app when Seira cannot", async () => {
    await render();
    await openMenu("hermes");
    expect(item("[data-provider-sign-out-note]")?.textContent).toBe(t("provider.signOutInApp", { name: "Hermes" }));
  });

  it("shows no sign-out note for a provider that is signed out", async () => {
    server.all = [kimi, { ...hermes, snapshot: { state: "available", authenticated: false } }];
    fixture.state = { instances: [...server.all], bots: [], config: {} };
    await render();
    await openMenu("hermes");
    expect(item("[data-provider-sign-out-note]")).toBeNull();
  });

  const keyed = (instanceId: string, displayName: string) => ready(instanceId, displayName, { driverKind: "grokAgent", access: "api", cliDefault: undefined });

  it("offers Remove key for a saved key, and the confirmation names the other providers that share it", async () => {
    server.all = [keyed("grok", "Grok"), keyed("xaiApi", "xAI"), hermes];
    fixture.state = { instances: [...server.all], bots: [], config: {} };
    await render();
    await openMenu("grok");
    await click(item("[data-provider-remove-key]"));
    expect(document.body.querySelector("[data-remove-key-shared]")?.textContent).toBe(t("provider.removeKeyShared", { names: "xAI" }));
    expect(document.body.textContent).toContain(t("provider.removeKeyTitle", { name: "Grok" }));
  });

  it("offers no Remove key to a provider that signs in without a saved key", async () => {
    await render();
    await openMenu("kimi");
    expect(item("[data-provider-remove-key]")).toBeNull();
  });
});

describe("a refused Hide", () => {
  const refuse = (uses: unknown[]) => { server.refuseHide = uses; };

  it("names what still uses the provider, with a way to change each one", async () => {
    refuse([
      { kind: "backup", botId: "robin", botName: "Robin" },
      { kind: "conversation", botId: "pen", botName: "Pen", threadId: "t1", title: "Weekly sales" },
      { kind: "default" },
    ]);
    await render();
    await openMenu("kimi");
    await click(item("[data-provider-hide]"));
    const list = document.body.querySelector("[data-provider-blockers]");
    expect(list?.textContent).toContain(t("provider.use.backup", { bot: "Robin" }));
    expect(list?.textContent).toContain(t("provider.use.conversation", { bot: "Pen", title: "Weekly sales" }));
    expect(list?.textContent).toContain(t("provider.use.default"));
    expect(list?.querySelectorAll("[data-provider-use] button")).toHaveLength(3);
    expect(status()).toBe("");
  });

  it("hides anyway after a confirm, and sends force", async () => {
    refuse([{ kind: "backup", botId: "robin", botName: "Robin" }]);
    await render();
    await openMenu("kimi");
    await click(item("[data-provider-hide]"));
    await click(document.body.querySelector("[data-provider-hide-anyway]"));
    expect(patches().at(-1)?.body).toEqual({ hidden: true });
    await click([...document.body.querySelectorAll("button")].find((button) => button.textContent === t("provider.hideAnyway") && button.closest("[role=dialog], [role=alertdialog]")));
    expect(patches().at(-1)?.body).toEqual({ hidden: true, force: true });
    expect(server.hidden.has("kimi")).toBe(true);
  });

  it("disables Hide anyway while a bot is working, and says to wait for it", async () => {
    refuse([{ kind: "running", botId: "pen", botName: "Pen" }]);
    await render();
    await openMenu("kimi");
    await click(item("[data-provider-hide]"));
    const button = document.body.querySelector<HTMLButtonElement>("[data-provider-hide-anyway]");
    expect(button?.disabled).toBe(true);
    expect(document.body.querySelector("[data-provider-hide-anyway-reason]")?.textContent).toBe(t("provider.hideAnywayWait", { bots: "Pen", name: "Kimi" }));
  });
});

describe("Move and hide picker", () => {
  const claude = (instanceId: string, displayName: string, extra: Partial<InstanceInfo> = {}) => ready(instanceId, displayName, { driverKind: "claudeAgent", ...extra });
  const codex = ready("codex", "Codex", { driverKind: "codex" });
  const setup = async (accounts: InstanceInfo[]) => {
    server.all = [claude("claude-1", "Claude 1"), ...accounts, codex];
    fixture.state = { instances: [...server.all], bots: [bot("a", "claude-1")], config: {} };
    await act(async () => { root.render(createElement(ProviderMenu, { instance: server.all[0]! })); });
    await click(container.querySelector('button[aria-haspopup="menu"]'));
  };
  const click = async (target: Element | null | undefined) => {
    expect(target).toBeTruthy();
    await act(async () => { (target as HTMLElement).click(); });
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
  };
  const picker = () => item("[data-provider-move-picker]");

  it("offers a picker with the other account of the same provider first, then the other AI", async () => {
    await setup([claude("claude-2", "Claude 2", { snapshot: { state: "available", authenticated: true, account: { email: "work@example.com" } } as InstanceInfo["snapshot"] })]);
    expect(item("[data-provider-move]")).toBeNull();
    await click(item("[data-provider-move-choose]"));
    expect(picker()).toBeTruthy();
    const targets = [...picker()!.querySelectorAll("[data-provider-move-to]")].map((row) => row.getAttribute("data-provider-move-to"));
    expect(targets).toEqual(["claude-2", "codex"]);
    expect(picker()!.textContent).toContain(t("provider.moveOtherAi"));
    expect(picker()!.textContent).toContain("work@example.com");
    await click(picker()!.querySelector('[data-provider-move-to="codex"]'));
    expect(server.persisted.map((entry) => entry.patch.modelSelection)).toEqual([{ instanceId: "codex", model: "codex-model" }]);
    expect(patches()).toContainEqual({ method: "PATCH", path: "/api/instances/claude-1", body: { hidden: true } });
  });

  it("shows an account that cannot run a task as a disabled row with its reason", async () => {
    await setup([claude("claude-2", "Claude 2"), claude("claude-3", "Claude 3", { snapshot: { state: "available", authenticated: false, version: "1" } })]);
    await click(item("[data-provider-move-choose]"));
    const row = picker()!.querySelector('[data-provider-move-to="claude-3"]') as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    expect(row.textContent).toContain(t("model.signInRequired"));
    await click(row);
    expect(server.persisted).toEqual([]);
  });

  it("goes back to the menu with Back", async () => {
    await setup([claude("claude-2", "Claude 2")]);
    await click(item("[data-provider-move-choose]"));
    await click(picker()!.querySelector("[data-provider-move-back]"));
    expect(picker()).toBeNull();
    expect(item("[data-provider-move-choose]")).toBeTruthy();
  });
});
