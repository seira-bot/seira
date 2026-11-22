import { Children, createElement, isValidElement, type DependencyList, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import { api } from "@/state/store";

// PluginsPanel's own state, seeded by call order: effects never run under server rendering, so the catalog is placed as
// a finished fetch would leave it.
const fixture = vi.hoisted(() => ({
  surface: "apps" as "apps" | "mcp",
  dispatch: vi.fn(),
  track: vi.fn(),
  bots: [] as unknown[],
  instances: [] as unknown[],
  overrides: new Map<number, unknown>(),
  index: 0,
  counting: false,
  effects: [] as Array<{ effect: EffectCallback; deps?: DependencyList }>,
  usage: [] as Array<{ app: string; calls: number }>,
  featured: [] as unknown[],
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useEffect: (effect: EffectCallback, deps?: DependencyList) => { fixture.effects.push({ effect, deps }); },
    useState: (initial: unknown) => {
      if (!fixture.counting) return react.useState(initial);
      const index = fixture.index++;
      const seeded = fixture.overrides.has(index) ? fixture.overrides.get(index) : typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [seeded, (value: unknown) => {
        const current = fixture.overrides.has(index) ? fixture.overrides.get(index) : seeded;
        fixture.overrides.set(index, typeof value === "function" ? (value as (current: unknown) => unknown)(current) : value);
      }];
    },
  };
});
vi.mock("@/state/store", () => ({
  api: vi.fn(() => new Promise(() => {})),
  useStore: () => ({
    state: { pluginsSurface: fixture.surface, bots: fixture.bots, instances: fixture.instances },
    dispatch: fixture.dispatch,
  }),
}));
vi.mock("@/lib/app-usage", () => ({ useAppUsage: () => fixture.usage }));
vi.mock("./McpServersPanel", async () => {
  const { HOSTED_MCP_APPS } = await import("@/lib/hosted-mcp-apps");
  return {
    McpServersPanel: ({ embedded, hostedCards }: { embedded?: boolean; hostedCards?: { shown(id: string): boolean } }) => hostedCards
      ? createElement("div", { "data-hosted-cards": true }, HOSTED_MCP_APPS.filter((app) => hostedCards.shown(app.id)).map((app) => createElement("div", { key: app.id, "data-hosted-app": app.id }, `Connect ${app.label}`)))
      : createElement("div", { "data-embedded": String(Boolean(embedded)) }, "MCP inventory"),
  };
});
vi.mock("@/lib/analytics", () => ({ track: fixture.track }));
vi.mock("./Avatar", () => ({ BotAvatar: ({ bot }: { bot: Bot }) => createElement("span", { "data-avatar": bot.id }) }));
vi.mock("./XCard", () => ({
  X_CARD_SEARCH: "x twitter treg tweets posts",
  XCard: () => createElement("div", { "data-x-card": true }, "X (Twitter)"),
}));
vi.mock("./EmailCard", () => ({
  EmailCard: () => createElement("div", { "data-email-card": true }, "Email"),
}));
import { HOSTED_MCP_APPS, type HostedConnections } from "@/lib/hosted-mcp-apps";
import { APPS_PREVIEW_COUNT, PluginsPanel, USED_BY_AVATAR_SIZE, botsUsingService, hostedShown } from "./PluginsPanel";
import { connectedInventoryCopy } from "@/lib/connector-status";

const CARDS = 0;
const CONFIGURED = 3;
const STATUS = 6;
const PHASE = 13;
const X_CONNECTED = 21;
const CATEGORY = 20;
const EMAIL_CONNECTED = 22;
const MODE = 4;
const SEARCH = 15;
const HOSTED_CONNECTED = 18;
const TAB = 16;

type Node = ReactElement<{ children?: ReactNode; "aria-pressed"?: boolean; "data-apps-filter"?: string; onClick?: () => void; [key: string]: unknown }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}
function render() {
  let tree!: ReturnType<typeof PluginsPanel>;
  function Capture() {
    fixture.index = 0;
    fixture.counting = true;
    try { tree = PluginsPanel(); } finally { fixture.counting = false; }
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}
const chip = (tree: Node[], id: string) => tree.find((node) => node.props["data-apps-filter"] === id)!;
const card = (slug: string) => ({ slug, label: slug[0]!.toUpperCase() + slug.slice(1), blurb: `${slug} things`, logo: null, domain: null });
const claude = { instanceId: "claude", capabilities: { composioMcp: true } } as unknown as InstanceInfo;
const bot = (id: string, extra: Partial<Bot> = {}) => ({ id, name: id, hidden: false, modelSelection: { instanceId: "claude", model: "m" }, ...extra }) as unknown as Bot;

beforeEach(() => {
  vi.stubGlobal("window", {});
  fixture.surface = "apps";
  fixture.dispatch.mockReset();
  fixture.track.mockReset();
  fixture.effects = [];
  fixture.usage = [];
  fixture.bots = [];
  fixture.instances = [];
  fixture.overrides = new Map<number, unknown>([
    [CARDS, [card("gmail"), card("slack"), card("notion")]],
    [CONFIGURED, true],
    [STATUS, { slack: { connected: true, accounts: [{ id: "ca_1", status: "ACTIVE" }] } }],
    [PHASE, "ready"],
  ]);
});
afterEach(() => vi.unstubAllGlobals());

describe("Apps pop-up", () => {
  it("shows each connected hosted app inside the apps grid without a Composio key or MCP detour", () => {
    fixture.overrides.set(CONFIGURED, false);
    fixture.overrides.set(HOSTED_CONNECTED, Object.fromEntries(HOSTED_MCP_APPS.map((app) => [app.id, true])));
    const { html, nodes: tree } = render();
    const grid = tree.find((node) => node.props["data-apps-grid"] !== undefined)!;
    expect(nodes(grid).some((node) => node.props.hostedCards !== undefined)).toBe(true);
    for (const app of HOSTED_MCP_APPS) {
      expect(html).toContain(`Connect ${app.label}`);
      expect(html).not.toContain(`Set up ${app.label}`);
    }
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });
  it("shows every hosted app in All, connected or not, and none in Connected until it is connected", () => {
    for (const hostedConnected of [null, Object.fromEntries(HOSTED_MCP_APPS.map((app) => [app.id, false]))]) {
      fixture.overrides.set(HOSTED_CONNECTED, hostedConnected);
      fixture.overrides.set(TAB, "marketplace");
      const html = render().html;
      for (const app of HOSTED_MCP_APPS) expect(html).toContain(`data-hosted-app="${app.id}"`);
      fixture.overrides.set(TAB, "connected");
      expect(render().html).not.toContain("data-hosted-app=");
    }
  });
  it("links the Privacy Policy and the Terms of Service below the apps", () => {
    const { html } = render();
    const legal = html.indexOf('<nav aria-label="Legal"');
    expect(legal).toBeGreaterThan(html.indexOf("data-apps-grid"));
    expect(html.slice(legal)).toMatch(/^<nav[^>]*>.*Privacy Policy.*Terms of Service.*?<\/nav>/s);
  });
  it("counts every connected hosted app among connected apps", () => {
    const everyApp = (connected: boolean) => Object.fromEntries(HOSTED_MCP_APPS.map((app) => [app.id, connected]));
    fixture.overrides.set(HOSTED_CONNECTED, everyApp(true));
    expect(render().html).toContain(`${1 + HOSTED_MCP_APPS.length} connected`);
    fixture.overrides.set(HOSTED_CONNECTED, { ...everyApp(false), [HOSTED_MCP_APPS[0].id]: true });
    expect(render().html).toContain("2 connected");
  });
  it.each(HOSTED_MCP_APPS)("finds $label by its own name and shows no other hosted card", (app) => {
    fixture.overrides.set(HOSTED_CONNECTED, Object.fromEntries(HOSTED_MCP_APPS.map((one) => [one.id, true])));
    fixture.overrides.set(SEARCH, app.label.toLowerCase());
    const html = render().html;
    expect(html).toContain(`data-hosted-app="${app.id}"`);
    expect(html.match(/data-hosted-app="/g)).toHaveLength(1);
  });
  it("shows only the connected hosted card under Connected", () => {
    fixture.overrides.set(TAB, "connected");
    fixture.overrides.set(HOSTED_CONNECTED, Object.fromEntries(HOSTED_MCP_APPS.map((app) => [app.id, app === HOSTED_MCP_APPS[0]])));
    const html = render().html;
    expect(html).toContain(`data-hosted-app="${HOSTED_MCP_APPS[0].id}"`);
    for (const other of HOSTED_MCP_APPS.slice(1)) expect(html).not.toContain(`data-hosted-app="${other.id}"`);
  });
  it.each(["mind map", "booking", "broadcast", "sales funnel", "comment", "join request"])("finds the one hosted card whose keywords match %s", (word) => {
    fixture.overrides.set(HOSTED_CONNECTED, null);
    fixture.overrides.set(SEARCH, word);
    expect(render().html.match(/data-hosted-app="/g)).toHaveLength(1);
  });
  it("finds every hosted WhatsApp card", () => {
    fixture.overrides.set(HOSTED_CONNECTED, null);
    fixture.overrides.set(SEARCH, "whatsapp");
    expect([...render().html.matchAll(/data-hosted-app="([^"]+)"/g)].map((match) => match[1]).sort()).toEqual(["citcat", "dalekta", "grupy", "konektor"]);
  });
  it("finds the two hosted cards whose text mentions a landing page", () => {
    fixture.overrides.set(HOSTED_CONNECTED, null);
    fixture.overrides.set(SEARCH, "landing page");
    expect([...render().html.matchAll(/data-hosted-app="([^"]+)"/g)].map((match) => match[1]).sort()).toEqual(["biver", "dalekta"]);
  });
  it("counts two connected hosted apps under Connected", () => {
    fixture.overrides.set(HOSTED_CONNECTED, { konektor: true, coret: true });
    expect(render().html).toContain("3 connected");
    fixture.overrides.set(TAB, "connected");
    const html = render().html;
    expect(html).toContain('data-hosted-app="konektor"');
    expect(html).toContain('data-hosted-app="coret"');
    expect(html).not.toContain('data-hosted-app="biver"');
  });
  it("names the connected hosted apps in the setup notice", () => {
    fixture.overrides.set(CONFIGURED, false);
    fixture.overrides.set(HOSTED_CONNECTED, Object.fromEntries(HOSTED_MCP_APPS.map((app) => [app.id, true])));
    const html = render().html;
    expect(html).toContain(`Connected: ${new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(HOSTED_MCP_APPS.map((app) => app.label))}.`);
  });
  it("hides the X card until it is connected, then shows it in the grid and under Connected", () => {
    const wrapper = (tree: Node[]) => tree.find((node) => node.props["data-native-card"] === "x")!;
    const { html, nodes: tree } = render();
    expect(nodes(wrapper(tree)).some((node) => node.props.onConnection !== undefined && node.props.refreshKey !== undefined)).toBe(true);
    expect(wrapper(tree).props.className).toBe("hidden");
    expect(html).toContain("1 connected");
    fixture.overrides.set(TAB, "connected");
    expect(wrapper(render().nodes).props.className).toBe("hidden");
    fixture.overrides.set(X_CONNECTED, true);
    expect(render().html).toContain("2 connected");
    expect(wrapper(render().nodes).props.className).toBe("contents");
    fixture.overrides.set(TAB, "marketplace");
    expect(wrapper(render().nodes).props.className).toBe("contents");
    fixture.overrides.set(SEARCH, "twitter");
    expect(wrapper(render().nodes).props.className).toBe("contents");
    fixture.overrides.set(SEARCH, "gmail");
    expect(wrapper(render().nodes).props.className).toBe("hidden");
  });
  it("hides the email card until a mailbox is connected, then shows it in the grid and under Connected", () => {
    const wrapper = (tree: Node[]) => tree.find((node) => node.props["data-native-card"] === "email")!;
    const { html, nodes: tree } = render();
    expect(nodes(wrapper(tree)).some((node) => node.props.onConnection !== undefined && node.props.refreshKey !== undefined)).toBe(true);
    expect(wrapper(tree).props.className).toBe("hidden");
    expect(html).toContain("1 connected");
    fixture.overrides.set(TAB, "connected");
    expect(wrapper(render().nodes).props.className).toBe("hidden");
    fixture.overrides.set(EMAIL_CONNECTED, true);
    expect(render().html).toContain("2 connected");
    expect(wrapper(render().nodes).props.className).toBe("contents");
    fixture.overrides.set(TAB, "marketplace");
    expect(wrapper(render().nodes).props.className).toBe("contents");
    fixture.overrides.set(SEARCH, "imap");
    expect(wrapper(render().nodes).props.className).toBe("contents");
    fixture.overrides.set(SEARCH, "twitter");
    expect(wrapper(render().nodes).props.className).toBe("hidden");
  });
  it("leaves a card that needs its own sign-in out of the grid unless it is connected", () => {
    const tile = (tree: Node[]) => tree.find((node) => node.props["data-app-tile"] === "linkedin");
    fixture.overrides.set(CARDS, [card("gmail"), { ...card("linkedin"), needsOwnAuth: true }]);
    expect(tile(render().nodes)).toBeUndefined();
    fixture.overrides.set(STATUS, { linkedin: { connected: true, accounts: [{ id: "ca_l", status: "ACTIVE" }] } });
    expect(tile(render().nodes)).toBeDefined();
  });
  it("leaves out the managed install's dead Twitter tile, which the X card replaces, unless it is already connected", () => {
    const tile = (tree: Node[]) => tree.find((node) => node.props["data-app-tile"] === "twitter");
    fixture.overrides.set(CARDS, [card("gmail"), card("twitter")]);
    fixture.overrides.set(MODE, "managed");
    expect(tile(render().nodes)).toBeUndefined();
    fixture.overrides.set(STATUS, { twitter: { connected: true, accounts: [{ id: "ca_x", status: "ACTIVE" }] } });
    expect(tile(render().nodes)).toBeDefined();
    fixture.overrides.set(STATUS, {});
    fixture.overrides.set(MODE, "self-hosted");
    expect(tile(render().nodes)).toBeDefined();
  });
  it("keeps a safe explicit authorization link and reopens without creating another account", async () => {
    const url = "https://auth.example.test/flow";
    fixture.overrides.set(STATUS, { gmail: { connected: false, pending: true } });
    fixture.overrides.set(8, { gmail: { url, createdAt: Date.now() } });
    const page = { opener: {}, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
    const open = vi.fn(() => page);
    vi.stubGlobal("window", { open });
    const { nodes: tree } = render();
    const link = tree.find((node) => node.type === "a" && node.props.href === url)!;
    expect(link.props.target).toBe("_blank");
    expect(link.props.rel).toBe("noopener noreferrer");
    const tile = tree.find((node) => node.props["data-app-tile"] === "gmail")!;
    const button = nodes(tile).find((node) => node.type === "button")!;
    vi.mocked(api).mockClear();
    button.props.onClick!();
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(page.opener).toBeNull();
    await Promise.resolve();
    expect(page.location.replace).toHaveBeenCalledWith(url);
    expect(api).not.toHaveBeenCalled();
    expect(page.close).not.toHaveBeenCalled();
  });

  it("reserves before requesting authorization and closes its blank when the panel closes", async () => {
    fixture.overrides.set(9, "gmail");
    fixture.overrides.set(10, "work");
    let resolve!: (value: unknown) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const page = { opener: {}, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
    const open = vi.fn(() => page);
    vi.stubGlobal("window", { open });
    const { nodes: tree } = render();
    const form = tree.find((node) => node.type === "form")!;
    (form.props.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault() {} });
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(open.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api).mock.invocationCallOrder.at(-1)!);
    const cleanup = fixture.effects.find(({ deps }) => deps?.length === 0)!.effect();
    if (typeof cleanup === "function") cleanup();
    expect(page.close).toHaveBeenCalledOnce();
    resolve({ url: "https://auth.example.test/late" });
    await Promise.resolve();
    expect(page.location.replace).not.toHaveBeenCalled();
  });

  it("renews an expired retained link without reusing its occupied account alias", async () => {
    fixture.overrides.set(STATUS, { gmail: { connected: false, pending: true, status: "INITIALIZING", accounts: [{ id: "ca_old", alias: "work", status: "INITIALIZING" }] } });
    fixture.overrides.set(8, { gmail: { url: "https://auth.example.test/old", createdAt: Date.now() - 600_000 } });
    vi.mocked(api).mockClear();
    vi.mocked(api).mockImplementationOnce(async (_path, request) => {
      if (request?.body) throw new Error("That account alias is already in use");
      return { url: "https://auth.example.test/new" };
    });
    const page = { opener: {}, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
    vi.stubGlobal("window", { open: () => page });
    const { nodes: tree } = render();
    expect(tree.some((node) => node.type === "a" && node.props.href === "https://auth.example.test/old")).toBe(false);
    const tile = tree.find((node) => node.props["data-app-tile"] === "gmail")!;
    nodes(tile).find((node) => node.type === "button")!.props.onClick!();
    expect(api).toHaveBeenCalledWith("/api/connectors/gmail/authorize", { method: "POST" });
    await Promise.resolve();
    expect(page.location.replace).toHaveBeenCalledWith("https://auth.example.test/new");
    const cleanup = fixture.effects.find(({ deps }) => deps?.length === 0)!.effect();
    if (typeof cleanup === "function") cleanup();
  });

  it("retries an INITIALIZING account after reload instead of polling without a usable link", async () => {
    fixture.overrides.set(STATUS, { gmail: { connected: false, pending: true, status: "INITIALIZING", accounts: [{ id: "ca_abandoned", alias: "work", status: "INITIALIZING" }] } });
    vi.mocked(api).mockClear();
    vi.mocked(api).mockResolvedValueOnce({ url: "https://auth.example.test/retry" });
    const page = { opener: {}, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
    vi.stubGlobal("window", { open: () => page });
    const { nodes: tree } = render();
    const tile = tree.find((node) => node.props["data-app-tile"] === "gmail")!;
    nodes(tile).find((node) => node.type === "button")!.props.onClick!();
    expect(api).toHaveBeenCalledWith("/api/connectors/gmail/authorize", { method: "POST" });
    await Promise.resolve();
    expect(page.location.replace).toHaveBeenCalledWith("https://auth.example.test/retry");
    const cleanup = fixture.effects.find(({ deps }) => deps?.length === 0)!.effect();
    if (typeof cleanup === "function") cleanup();
  });

  it("shows an app whose only account expired as signed out, and reconnects that account under its own label", async () => {
    fixture.overrides.set(STATUS, { gmail: { connected: true, pending: false, status: "EXPIRED", accounts: [{ id: "ca_old", alias: "work", status: "EXPIRED" }] } });
    vi.mocked(api).mockClear();
    vi.mocked(api).mockResolvedValueOnce({ removed: 1 }).mockResolvedValueOnce({ url: "https://auth.example.test/again" });
    const page = { opener: {}, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
    vi.stubGlobal("window", { open: () => page });
    const { html, nodes: tree } = render();
    const tile = nodes(tree.find((node) => node.props["data-app-tile"] === "gmail"));
    expect(tile.some((node) => node.props["aria-label"] === "Connected")).toBe(false);
    expect(tile.some((node) => node.props.title === "Signed out. Reconnect to keep using it.")).toBe(true);
    expect(html).not.toContain("1 connected");
    const button = tile.find((node) => node.type === "button")!;
    expect(button.props.children).toBe("Reconnect");
    expect(tile.filter((node) => node.type === "button").map((node) => node.props.children)).not.toContain("Add account");
    button.props.onClick!();
    await vi.waitFor(() => expect(page.location.replace).toHaveBeenCalledWith("https://auth.example.test/again"));
    expect(vi.mocked(api).mock.calls).toEqual([
      ["/api/connectors/gmail/accounts/ca_old", { method: "DELETE" }],
      ["/api/connectors/gmail/authorize", { method: "POST", body: JSON.stringify({ alias: "work" }) }],
    ]);
  });

  it("reports how a Connect ended once, by its curated app, and nothing after the panel closes", async () => {
    vi.useFakeTimers();
    try {
      const page = { opener: {}, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
      vi.stubGlobal("window", { open: () => page });
      const connectApp = async (slug: string) => {
        fixture.overrides.set(CARDS, [card(slug)]);
        fixture.overrides.set(9, slug);
        fixture.overrides.set(10, "work");
        vi.mocked(api).mockReset();
        vi.mocked(api).mockResolvedValueOnce({ url: `https://auth.example.test/${slug}` });
        const form = render().nodes.find((node) => node.type === "form")!;
        (form.props.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault() {} });
        await vi.advanceTimersByTimeAsync(0);
        expect(page.location.replace).toHaveBeenLastCalledWith(`https://auth.example.test/${slug}`);
        vi.mocked(api).mockResolvedValue({ services: { [slug]: { connected: true, pending: false, status: "ACTIVE" } } });
      };
      await connectApp("gmail");
      await vi.advanceTimersByTimeAsync(20_000);
      expect(fixture.track.mock.calls).toEqual([["connector_connect", { app: "gmail", result: "connected" }]]);

      fixture.track.mockReset();
      await connectApp("acme-internal-crm");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fixture.track.mock.calls).toEqual([["connector_connect", { app: "other", result: "connected" }]]);

      fixture.track.mockReset();
      fixture.effects = [];
      await connectApp("notion");
      const cleanup = fixture.effects.find(({ deps }) => deps?.length === 0)!.effect();
      if (typeof cleanup === "function") cleanup();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fixture.track).not.toHaveBeenCalled();
    } finally {
      vi.mocked(api).mockReset();
      vi.useRealTimers();
    }
  });

  it("reports an Add account connected once the new account works, not when the app's other account already does", async () => {
    vi.useFakeTimers();
    try {
      const page = { opener: {}, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
      vi.stubGlobal("window", { open: () => page });
      fixture.overrides.set(CARDS, [card("slack")]);
      fixture.overrides.set(9, "slack");
      fixture.overrides.set(10, "home");
      vi.mocked(api).mockReset();
      vi.mocked(api).mockResolvedValueOnce({ url: "https://auth.example.test/slack" });
      const form = render().nodes.find((node) => node.type === "form")!;
      (form.props.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault() {} });
      await vi.advanceTimersByTimeAsync(0);
      const working = { id: "ca_1", status: "ACTIVE" };
      vi.mocked(api).mockResolvedValue({ services: { slack: { connected: true, pending: true, status: "ACTIVE", accounts: [working, { id: "ca_2", status: "INITIATED" }] } } });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(fixture.track).not.toHaveBeenCalled();
      vi.mocked(api).mockResolvedValue({ services: { slack: { connected: true, pending: false, status: "ACTIVE", accounts: [working, { id: "ca_2", status: "ACTIVE" }] } } });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fixture.track.mock.calls).toEqual([["connector_connect", { app: "slack", result: "connected" }]]);
    } finally {
      vi.mocked(api).mockReset();
      vi.useRealTimers();
    }
  });

  it("offers Reconnect on a dead account beside a working one", () => {
    fixture.overrides.set(STATUS, { gmail: { connected: true, pending: false, status: "ACTIVE", accounts: [
      { id: "ca_personal", alias: "personal", status: "ACTIVE" },
      { id: "ca_work", alias: "work", status: "FAILED" },
    ] } });
    const { html, nodes: tree } = render();
    const tile = nodes(tree.find((node) => node.props["data-app-tile"] === "gmail"));
    expect(tile.some((node) => node.props["aria-label"] === "Connected")).toBe(true);
    expect(tile.find((node) => node.type === "button")!.props.children).toBe("Add account");
    expect(html).toContain('aria-label="Reconnect work to Gmail"');
    expect(html).not.toContain('aria-label="Reconnect personal to Gmail"');
  });

  it("shows the required alias form for mixed active and unfinished accounts", async () => {
    fixture.overrides.set(STATUS, { gmail: { connected: true, pending: true, status: "ACTIVE", accounts: [
      { id: "ca_active", alias: "work", status: "ACTIVE" },
      { id: "ca_abandoned", status: "INITIALIZING" },
    ] } });
    vi.mocked(api).mockClear();
    vi.mocked(api).mockRejectedValueOnce(new Error("Add an account alias so the existing connection is not replaced"));
    const page = { opener: {}, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
    vi.stubGlobal("window", { open: () => page });
    const initial = render();
    const tile = initial.nodes.find((node) => node.props["data-app-tile"] === "gmail")!;
    nodes(tile).find((node) => node.type === "button")!.props.onClick!();
    await Promise.resolve();
    const recovered = render();
    const recoveredTile = recovered.nodes.find((node) => node.props["data-app-tile"] === "gmail")!;
    expect(nodes(recoveredTile).some((node) => node.type === "form")).toBe(true);
    expect(recovered.html).toContain('aria-label="Label for another Gmail account"');
    expect(page.close).toHaveBeenCalledOnce();
    expect(page.location.replace).not.toHaveBeenCalled();
  });

  it("focuses and wraps through visible controls in a narrow window", () => {
    let active: Control;
    const focusElement = (element: Control) => { active = element; };
    class Control {
      constructor(readonly input = false, public visible = true) {}
      focus = vi.fn(() => focusElement(this));
      getClientRects = () => this.visible ? [{}] : [];
      matches = (selector: string) => selector === "input" && this.input;
    }
    const hiddenDesktopSearch = new Control(true, false);
    const first = new Control();
    const mobileSearch = new Control(true);
    const last = new Control();
    const opener = new Control();
    active = opener;
    const pane = Object.assign(new Control(), {
      querySelectorAll: () => [hiddenDesktopSearch, first, mobileSearch, last],
    });
    const listeners = new Map<string, (event: KeyboardEvent) => void>();
    vi.stubGlobal("HTMLElement", Control);
    vi.stubGlobal("document", { get activeElement() { return active; } });
    vi.stubGlobal("window", {
      addEventListener: (name: string, listener: (event: KeyboardEvent) => void) => listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
    });
    const { nodes: tree } = render();
    const dialog = tree.find((node) => node.props.role === "dialog")!;
    (dialog.props.ref as { current: unknown }).current = pane;
    const cleanup = fixture.effects.find(({ deps }) => deps?.length === 1 && deps[0] === fixture.dispatch)!.effect();
    expect(mobileSearch.focus).toHaveBeenCalledOnce();
    expect(hiddenDesktopSearch.focus).not.toHaveBeenCalled();

    const tab = (shiftKey = false) => {
      const event = { key: "Tab", shiftKey, preventDefault: vi.fn() };
      listeners.get("keydown")!(event as unknown as KeyboardEvent);
      return event;
    };
    active = last;
    expect(tab().preventDefault).toHaveBeenCalledOnce();
    expect(active).toBe(first);
    expect(tab(true).preventDefault).toHaveBeenCalledOnce();
    expect(active).toBe(last);

    active = hiddenDesktopSearch;
    expect(tab().preventDefault).toHaveBeenCalledOnce();
    expect(active).toBe(first);
    expect(hiddenDesktopSearch.focus).not.toHaveBeenCalled();
    if (typeof cleanup === "function") cleanup();
    expect(active).toBe(opener);
  });

  it("is titled Apps and shows app tiles and the MCP servers section on one view", () => {
    const { html } = render();
    expect(html).toContain(">Apps</h2>");
    expect(html).toContain("Connect an app or your own MCP server once. Then choose which bots may use it.");
    expect(html).toContain("glass-surface");
    expect(html).toContain("@container");
    expect(html).toContain("grid grid-cols-1 items-start gap-x-6 gap-y-1 @xl:grid-cols-2");
    for (const slug of ["gmail", "slack", "notion"]) expect(html).toContain(`data-app-tile="${slug}"`);
    expect(html.indexOf('data-app-tile="slack"')).toBeLessThan(html.indexOf('data-app-tile="gmail"'));
    expect(html).toContain("MCP inventory");
    expect(html).toContain('data-embedded="true"');
    expect(html).not.toContain('role="tab"');
  });

  it("filters with chips, keeping the MCP chip on the store's surface", () => {
    const initial = render();
    expect(chip(initial.nodes, "all").props["aria-pressed"]).toBe(true);
    chip(initial.nodes, "mcp").props.onClick!();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "togglePlugins", open: true, surface: "mcp" });

    fixture.surface = "mcp";
    const mcp = render();
    expect(chip(mcp.nodes, "mcp").props["aria-pressed"]).toBe(true);
    expect(mcp.html).toContain("MCP inventory");
    expect(mcp.html).not.toContain("data-app-tile");
    chip(mcp.nodes, "connected").props.onClick!();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "togglePlugins", open: true, surface: "apps" });
  });

  it("drops a selected category when a filter is chosen, so the MCP section comes back", () => {
    fixture.overrides.set(20, "design");
    expect(render().html).not.toContain("MCP inventory");
    chip(render().nodes, "mcp").props.onClick!();
    expect(fixture.overrides.get(20)).toBeNull();
    expect(render().html).toContain("MCP inventory");
  });

  it("shows only connected apps, and no MCP section, under Connected", () => {
    fixture.overrides.set(16, "connected");
    const { html, nodes: tree } = render();
    expect(chip(tree, "connected").props["aria-pressed"]).toBe(true);
    expect(html).toContain('data-app-tile="slack"');
    expect(html).not.toContain('data-app-tile="gmail"');
    expect(html).not.toContain("MCP inventory");
    expect(html).toContain("1 connected");
  });

  it("groups the catalog into connected apps, category previews and every app, with a View all per section", () => {
    const categorized = (slug: string, category: string) => ({ ...card(slug), categories: [category] });
    fixture.overrides.set(CARDS, [
      categorized("slack", "Communication"),
      categorized("gmail", "Communication"),
      ...Array.from({ length: 5 }, (_, index) => categorized(`doc${index}`, "Productivity")),
      categorized("figma", "Design"),
      ...["Files", "Finance", "Social", "Analytics"].map((category) => categorized(category.toLowerCase(), category)),
    ]);
    const { html, nodes: tree } = render();
    const headings = [...html.matchAll(/<h3 id="[^"]*"[^>]*>([^<]*)/g)].map((match) => match[1]);
    expect(headings).toEqual(["Featured", "Connected", "Productivity", "Communication", "Analytics", "All apps"]);
    expect(tree.filter((node) => node.props["data-apps-category"]).map((node) => node.props["data-apps-category"])).toEqual(["productivity", "communication", "analytics", "design", "files"]);
    expect(html).toContain('aria-label="More categories"');
    // The dialog clips overflow, so the menu must portal out of it rather than open in place.
    expect(tree.find((node) => node.props.ariaLabel === "More categories")!.props.placement).toBeUndefined();
    tree.find((node) => node.props["data-apps-category"] === "design")!.props.onClick!();
    const design = render();
    expect(design.html.match(new RegExp(`data-app-tile="(?!${HOSTED_MCP_APPS.map((app) => app.id).join("|")})[^"]*"`, "g"))).toEqual(['data-app-tile="figma"']);
    expect([...design.html.matchAll(/<h3 id="[^"]*"[^>]*>([^<]*)/g)].map((match) => match[1])).toEqual(["Design"]);
    expect(chip(design.nodes, "all").props["aria-pressed"]).toBe(false);
    expect(design.nodes.find((node) => node.props["data-apps-category"] === "design")!.props["aria-pressed"]).toBe(true);
    fixture.overrides.set(20, null);
    const again = render();
    expect(again.html.match(/>View all</g)).toHaveLength(1);
    const sections = again.nodes.filter((node) => node.props.viewAll);
    expect(sections.map((node) => node.props.title)).toEqual(["Productivity"]);
    (sections[0]!.props.viewAll as { onClick: () => void }).onClick();
    expect(fixture.overrides.get(20)).toBe("productivity");
  });

  const MCP_SERVERS = 23, SUGGESTIONS = 27;
  const headings = (html: string) => [...html.matchAll(/<h3 id="[^"]*"[^>]*>([^<]*)/g)].map((match) => match[1]);
  const tiles = (html: string) => [...html.matchAll(/data-app-tile="([^"]*)"/g)].map((match) => match[1]).filter((slug) => !HOSTED_MCP_APPS.some((app) => app.id === slug));
  const server = (name: string, extra: Record<string, unknown> = {}) => ({ name, type: "http", url: `https://${name}.example/mcp`, headerKeys: [], enabled: true, ...extra });
  const suggestedAction = (tree: Node[]) => tree.find((node) => node.props.id === "apps-section-suggested")!.props.viewAll as { label: string; onClick: () => void } | undefined;

  it("searches the whole catalog from the Connected view and from a category, not only what they show", () => {
    fixture.overrides.set(TAB, "connected");
    fixture.overrides.set(SEARCH, "notion");
    let { html, nodes: tree } = render();
    expect(tiles(html)).toEqual(["notion"]);
    expect(headings(html)).toEqual(["Search results"]);
    expect(chip(tree, "connected").props["aria-pressed"]).toBe(true);

    fixture.overrides.set(TAB, "marketplace");
    fixture.overrides.set(CATEGORY, "design");
    fixture.overrides.set(SEARCH, " Notion ");
    ({ html } = render());
    expect(tiles(html)).toEqual(["notion"]);
  });

  it("searches an app's category too, in any word order", () => {
    fixture.overrides.set(CARDS, [{ ...card("sheets"), label: "Sheet Thing", categories: ["Spreadsheets"] }, card("gmail")]);
    fixture.overrides.set(SEARCH, "spreadsheets thing");
    expect(tiles(render().html)).toEqual(["sheets"]);
    fixture.overrides.set(SEARCH, "productivity");
    expect(tiles(render().html)).toEqual(["sheets"]);
  });

  it("shows Suggested for you after Connected, the same tiles, with the on-demand button", () => {
    fixture.overrides.set(SUGGESTIONS, { cards: [card("notion"), card("gmail")], pick: "available" });
    const { html, nodes: tree } = render();
    expect(headings(html).slice(1, 3)).toEqual(["Connected", "Suggested for you"]);
    expect(html).toContain('data-apps-section="apps-section-suggested"');
    expect(html.match(/data-app-tile="notion"/g)!.length).toBeGreaterThanOrEqual(2);
    expect(suggestedAction(tree)!.label).toBe("Show suggested");
    vi.mocked(api).mockClear();
    suggestedAction(tree)!.onClick();
    expect(vi.mocked(api).mock.calls).toEqual([["/api/connectors/suggestions/pick", { method: "POST" }]]);
  });

  it("drops an app from Suggested once it is connected, and leaves the section out when nothing is left", () => {
    fixture.overrides.set(SUGGESTIONS, { cards: [card("slack")], pick: "available" });
    expect(headings(render().html)).not.toContain("Suggested for you");
    fixture.overrides.set(STATUS, {});
    expect(headings(render().html)[1]).toBe("Suggested for you");
  });

  it("points to Settings for a key when no decision model is available, and hides the button after a pick", () => {
    fixture.overrides.set(SUGGESTIONS, { cards: [card("notion")], pick: "needs-key" });
    let { html, nodes: tree } = render();
    expect(suggestedAction(tree)!.label).toBe("Add a Jev key in Settings");
    suggestedAction(tree)!.onClick();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "togglePlugins", open: false });
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "toggleAppSettings", open: true }));

    fixture.overrides.set(SUGGESTIONS, { cards: [card("notion")], pick: "picked" });
    ({ html, nodes: tree } = render());
    expect(suggestedAction(tree)).toBeUndefined();
    expect(html).toContain("Picked for what you&#x27;ve connected");
  });

  it("counts connected MCP servers, one rule, and never a hosted app's or one that is off or signed out", () => {
    fixture.overrides.set(MCP_SERVERS, [
      server("docs"),
      server("signedin", { auth: "signed-in" }),
      { name: "local", command: "npx", args: ["x"], envKeys: [], enabled: true },
      server("needs", { auth: "needs-sign-in" }),
      server("off", { enabled: false }),
      server("hosted", { url: HOSTED_MCP_APPS[0]!.url, auth: "signed-in" }),
    ]);
    expect(render().html).toContain("4 connected");
  });

  it("hands the Connected view's search to the MCP tiles, and only there", () => {
    fixture.overrides.set(MCP_SERVERS, [server("docs"), server("wiki")]);
    const props = (tree: Node[]) => tree.find((node) => node.props.hostedCards)!.props.hostedCards as { ownServers?: { shown(one: unknown): boolean; manage(): void } };
    expect(props(render().nodes).ownServers).toBeUndefined();
    fixture.overrides.set(TAB, "connected");
    fixture.overrides.set(SEARCH, "wiki");
    const { ownServers } = props(render().nodes);
    expect(ownServers!.shown(server("wiki"))).toBe(true);
    expect(ownServers!.shown(server("docs"))).toBe(false);
    ownServers!.manage();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "togglePlugins", open: true, surface: "mcp" });
  });

  it("doesn't call the Connected view empty while an MCP server is listed there", () => {
    fixture.overrides.set(STATUS, {});
    fixture.overrides.set(TAB, "connected");
    fixture.overrides.set(21, false); fixture.overrides.set(22, false);
    fixture.overrides.set(18, Object.fromEntries(HOSTED_MCP_APPS.map((app) => [app.id, false])));
    const emptyTitle = connectedInventoryCopy("ready").title;
    expect(render().html).toContain(emptyTitle);
    fixture.overrides.set(MCP_SERVERS, [server("docs")]);
    expect(render().html).not.toContain(emptyTitle);
  });

  it("pairs the search with an MCP servers pill and puts the connected count, with app icons, in the header", () => {
    const { html, nodes: tree } = render();
    expect(chip(tree, "mcp").props["aria-pressed"]).toBe(false);
    const indicator = chip(tree, "connected");
    expect(indicator.props["aria-pressed"]).toBe(false);
    expect(html).toContain("1 connected");
    indicator.props.onClick!();
    expect(fixture.overrides.get(16)).toBe("connected");
  });

  it("caps the unsearched catalog so the MCP servers stay a short scroll away", () => {
    fixture.overrides.set(CARDS, Array.from({ length: APPS_PREVIEW_COUNT + 5 }, (_, index) => card(`app${index}`)));
    const { html } = render();
    expect(html.match(/data-app-tile=/g)).toHaveLength(APPS_PREVIEW_COUNT);
    expect(html).toContain(`Show all ${APPS_PREVIEW_COUNT + 5} apps`);
  });

  it("keeps the stale notice reachable and no longer sends people to a settings page for per-bot access", () => {
    fixture.instances = [claude];
    fixture.bots = [bot("scout", { composio: false })];
    fixture.overrides.set(7, true);
    let { html } = render();
    expect(html).toContain("Showing what was connected last time");
    fixture.overrides.set(7, false);
    ({ html } = render());
    expect(html).not.toContain("Settings → Access");
  });

  it("names the bots that use a connected app", () => {
    fixture.instances = [claude];
    fixture.bots = [bot("scout"), bot("quiet", { composio: false }), bot("narrow", { connectorTools: { gmail: { tools: "*" } } })];
    const { html } = render();
    expect(html).toContain('aria-label="Used by scout"');
    expect(botsUsingService(fixture.bots as Bot[], fixture.instances as InstanceInfo[], "gmail").map((entry) => entry.id)).toEqual(["scout", "narrow"]);
  });

  it("keeps each bot's avatar inside its round ring, whatever its shape", () => {
    fixture.instances = [claude];
    fixture.bots = [
      bot("scout"),
      bot("arrow", { mascotBody: "cursor" }),
      bot("photo", { avatarUrl: "/api/attachments/photo.webp", avatarCrop: "square" }),
    ];
    const { nodes: tree } = render();
    const rings = tree.filter((node) => node.props["data-used-by-avatar"] !== undefined);
    expect(rings.map((ring) => ring.props["data-used-by-avatar"])).toEqual(["scout", "arrow", "photo"]);
    for (const ring of rings) {
      expect(String(ring.props.className).split(" ")).toEqual(expect.arrayContaining([
        "flex", "size-5", "shrink-0", "items-center", "justify-center", "overflow-hidden", "rounded-full", "bg-menu", "ring-2", "ring-menu",
      ]));
      const avatar = Children.only(ring.props.children) as Node;
      expect(avatar.props.size).toBe(USED_BY_AVATAR_SIZE);
    }
  });
});

describe("hostedShown", () => {
  const [konektor, biver] = HOSTED_MCP_APPS;
  const none = Object.fromEntries(HOSTED_MCP_APPS.map((app) => [app.id, false])) as HostedConnections;
  const only = { ...none, [biver.id]: true } as HostedConnections;

  it("shows a card in All whether or not it is connected", () => {
    expect(hostedShown(konektor, "", none, "all")).toBe(true);
    expect(hostedShown(konektor, "", null, "all")).toBe(true);
  });
  it("shows a card in Connected only while it is connected", () => {
    expect(hostedShown(biver, "", none, "connected")).toBe(false);
    expect(hostedShown(biver, "", null, "connected")).toBe(false);
    expect(hostedShown(biver, "", only, "connected")).toBe(true);
    expect(hostedShown(konektor, "", only, "connected")).toBe(false);
  });
  it("respects the search in every view", () => {
    expect(hostedShown(konektor, "whatsapp", none, "all")).toBe(true);
    expect(hostedShown(konektor, "mind map", none, "all")).toBe(false);
    expect(hostedShown(biver, "mind map", only, "connected")).toBe(false);
    expect(hostedShown(biver, "landing page", only, "connected")).toBe(true);
  });
});

describe("Featured and Popular sections", () => {
  const sectionIds = (tree: Node[]) => nodes(tree.find((node) => node.props["data-apps-grid"] !== undefined)!).map((node) => node.props.id).filter((id): id is string => typeof id === "string" && id.startsWith("apps-section-") || id === "apps-grid-title");
  const hostedProps = (tree: Node[]) => nodes(tree.find((node) => node.props["data-apps-grid"] !== undefined)!).find((node) => node.props.hostedCards !== undefined)!.props.hostedCards as { featured?: unknown };
  const featuredIndex = () => { render(); return fixture.index - 1; };

  it("shows a Featured section first, with the place for every hosted card", () => {
    const { html, nodes: tree } = render();
    expect(sectionIds(tree)[0]).toBe("apps-section-featured");
    expect(html).toContain('data-apps-section="apps-section-featured"');
    expect(html.indexOf("data-featured-slot")).toBeGreaterThan(html.indexOf('data-apps-section="apps-section-featured"'));
    expect(html.indexOf("data-featured-slot")).toBeLessThan(html.indexOf('data-apps-section="apps-grid-title"'));
  });

  it("hands the Featured place to the one hosted panel while the sections show, and takes it back for a search or a category", () => {
    const slot = {};
    fixture.overrides.set(featuredIndex(), slot);
    expect(hostedProps(render().nodes).featured).toBe(slot);
    fixture.overrides.set(SEARCH, "gmail");
    expect(hostedProps(render().nodes).featured).toBeNull();
    fixture.overrides.set(SEARCH, "");
    fixture.overrides.set(CATEGORY, "design");
    expect(hostedProps(render().nodes).featured).toBeNull();
  });

  it("shows no Featured section for a search, and the matching hosted card stays in the results", () => {
    fixture.overrides.set(HOSTED_CONNECTED, null);
    fixture.overrides.set(SEARCH, HOSTED_MCP_APPS[0].label.toLowerCase());
    const { html, nodes: tree } = render();
    expect(sectionIds(tree)).not.toContain("apps-section-featured");
    expect(html).not.toContain("data-featured-slot");
    expect(html).toContain(`data-hosted-app="${HOSTED_MCP_APPS[0].id}"`);
  });

  it("shows no Popular section while no app has calls", () => {
    expect(sectionIds(render().nodes)).not.toContain("apps-section-popular");
  });

  it("shows the most called apps under Featured, most calls first, and not again below", () => {
    fixture.usage = [{ app: "NOTION", calls: 9 }, { app: "SLACK", calls: 4 }, { app: "NOSUCHAPP", calls: 3 }];
    const { html, nodes: tree } = render();
    expect(sectionIds(tree).slice(0, 2)).toEqual(["apps-section-featured", "apps-section-popular"]);
    const popular = tree.find((node) => node.props.id === "apps-section-popular")!;
    expect(nodes(popular.props.children).filter((node) => node.props["data-app-tile"]).map((node) => node.props["data-app-tile"])).toEqual(["notion", "slack"]);
    expect(html).toContain("Used most by your bots this week");
    expect(html.match(/data-app-tile="notion"/g)).toHaveLength(1);
    expect(html.match(/data-app-tile="slack"/g)).toHaveLength(1);
  });

  it("shows no Popular section for a search", () => {
    fixture.usage = [{ app: "NOTION", calls: 9 }];
    fixture.overrides.set(SEARCH, "notion");
    expect(sectionIds(render().nodes)).not.toContain("apps-section-popular");
  });
});
