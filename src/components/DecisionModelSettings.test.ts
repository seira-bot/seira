import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigStatus } from "@/state/store";
import { setLocale } from "@/lib/i18n";
import { DecisionModelSettings, deciderFailureText, helpersStatusLine, pickedProvider } from "./DecisionModelSettings";
import { CloudflareMark, OpenRouterMark, TypeSafeMark } from "./ProviderIcons";
import { Switch } from "./SettingsPrimitives";

const fixture = vi.hoisted(() => ({
  values: [] as unknown[], index: 0, effects: [] as Array<() => unknown>,
  config: null as ConfigStatus | null,
  api: vi.fn(), dispatch: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = initial;
    return [fixture.values[index], (next: unknown) => { fixture.values[index] = next; }];
  },
  useEffect: (effect: () => unknown) => { fixture.effects.push(effect); },
}));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }),
}));

const KEY = "tsk_ui_secret_key_value";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}
function render() {
  let tree: ReactNode = null;
  function Capture() { fixture.index = 0; fixture.effects = []; tree = DecisionModelSettings(); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  const all = nodes(tree);
  const byTestId = (id: string) => all.filter((node) => node.props["data-testid"] === id);
  const radios = all.filter((node) => node.type === "input" && node.props.type === "radio");
  return {
    html,
    all,
    byTestId,
    switches: all.filter((node) => node.type === Switch),
    master: byTestId("decider-master")[0]!,
    job: byTestId("decider-job-roomRouting")[0]!,
    radios,
    pick: (id: string) => radios.find((node) => node.props.value === id),
    model: byTestId("decider-model")[0],
    customApi: byTestId("decider-custom-api")[0],
    save: byTestId("decider-save")[0],
    test: byTestId("decider-test")[0]!,
    manage: byTestId("decider-manage-keys")[0],
    key: byTestId("decider-key")[0],
    account: byTestId("decider-account")[0],
  };
}
const click = (node: Node) => (node.props.onClick as () => void)();
const type = (node: Node, value: string) => (node.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
const choose = (node: Node) => (node.props.onChange as () => void)();
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
type Decider = NonNullable<ConfigStatus["decider"]>;
type Helpers = NonNullable<ConfigStatus["helpers"]>;
const status = (decider: Partial<Decider> = {}, helpers?: { own?: Partial<Helpers["own"]> } & Omit<Partial<Helpers>, "own">) => ({
  decider: { provider: "jev", configured: false, enabled: false, jobs: { roomRouting: true }, ...decider },
  ...(helpers ? { helpers: { extraction: { ready: false }, ...helpers, own: { jev: false, workersAi: false, openrouter: false, ...helpers.own } } } : {}),
} as ConfigStatus);
const change = (node: Node, value: string) => (node.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
const runEffects = () => { for (const effect of fixture.effects) effect(); };
const SHARED = { configured: true, keySource: "shared", sharedKey: true } as const;
const openrouter = (extra: Partial<Decider> = {}) =>
  status({ provider: "openrouter", chosen: "openrouter", model: "openai/gpt-4.1-nano", configured: false, enabled: false, ...extra });
const MODELS = {
  source: "openrouter",
  models: [
    { id: "openai/gpt-4.1-nano", name: "OpenAI: GPT-4.1 Nano", group: "recommended" },
    { id: "meta-llama/llama-3.3-70b-instruct", name: "Meta: Llama 3.3 70B Instruct", group: "recommended" },
    { id: "acme/zippy", name: "Acme: Zippy", group: "more" },
  ],
};
const optionsOf = (node: Node) => nodes(node.props.children).filter((child) => child.type === "option").map((child) => child.props.value);
const count = (html: string, text: string) => html.split(text).length - 1;

beforeEach(() => {
  fixture.values = [];
  fixture.config = status();
  fixture.api.mockReset();
  fixture.dispatch.mockReset().mockImplementation(({ config }: { config: ConfigStatus }) => { fixture.config = config; });
  vi.stubGlobal("window", {});
});

afterEach(() => { setLocale("en"); vi.unstubAllGlobals(); });

describe("DecisionModelSettings", () => {
  it("shows what it does first, then one provider picker, then only the picked provider's fields", () => {
    const view = render();
    const order = ["Small, fast models that sort and read things for your bots", "Use fast decisions and extraction", "Decisions: not set up · Extraction: not set up",
      "Who answers in rooms", "Provider", "Cloudflare Workers AI (free tier)", "TypeSafe Jev", "OpenRouter", "Custom endpoint", "Account ID", "API token"]
      .map((text) => view.html.indexOf(text));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const gone of ["Another key", "What it decides", "Jev API key", "OpenRouter API key", "Endpoint API key"]) expect(view.html).not.toContain(gone);
    expect(view.html).toContain("Not set up");
    expect(view.html).toContain('href="https://dash.cloudflare.com/profile/api-tokens"');
    expect(view.master.props.checked).toBe(false);
    expect(view.master.props.disabled).toBe(true);
    expect(view.html).toContain("Save a key below to turn this on.");
  });

  it("offers each provider once, as a radio row with its brand mark in the leading slot, and Jev only once", () => {
    const view = render();
    expect(view.radios.map((node) => node.props.value)).toEqual(["workersai", "jev", "openrouter", "custom"]);
    expect(view.pick("workersai")!.props.checked).toBe(true);
    expect(count(view.html, "TypeSafe Jev")).toBe(1);
    const rows = view.all.filter((node) => node.type === "label" && node.props["data-decider-pick"]);
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(nodes(row.props.children).some((child) => child.props["data-settings-slot"] === "")).toBe(true);
    const marked = (id: string, mark: unknown) => nodes(rows.find((row) => row.props["data-decider-pick"] === id)!.props.children).some((child) => child.type === mark);
    expect([marked("workersai", CloudflareMark), marked("jev", TypeSafeMark), marked("openrouter", OpenRouterMark)]).toEqual([true, true, true]);
    expect(view.html).toContain('role="radiogroup"');
  });

  it("offers the plan's included decisions only while the plan provides them, and picks them for a new install", () => {
    expect(render().pick("included")).toBeUndefined();
    fixture.config = status({ includedAvailable: true });
    const view = render();
    expect(view.radios.map((node) => node.props.value)).toEqual(["included", "workersai", "jev", "openrouter", "custom"]);
    expect(view.pick("included")!.props.checked).toBe(true);
    expect(view.html).toContain("No key needed.");
    expect(view.key).toBeUndefined();
    expect(view.save).toBeUndefined();
  });

  it("uses an invariable status for missing decisions and extraction in pt-BR", () => {
    setLocale("pt-br");
    expect(helpersStatusLine(null)).toBe("Decisões: sem configuração · Extração: sem configuração");
  });

  it("picking a provider saves the pick, drops a half-typed key and an old verdict, and shows only its fields", async () => {
    fixture.config = status({}, {});
    type(render().key!, "half-typed");
    fixture.values[6] = { ok: true, text: "old verdict" };
    fixture.api.mockResolvedValueOnce(status({ chosen: "jev" }, {}));
    choose(render().pick("jev")!);
    await flush();
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { provider: "jev" } }) });
    let view = render();
    expect(view.pick("jev")!.props.checked).toBe(true);
    expect(view.key!.props.value).toBe("");
    expect(view.key!.props["aria-label"]).toBe("Jev API key");
    expect(view.html).not.toContain("old verdict");
    expect(view.account).toBeUndefined();
    expect(view.model).toBeUndefined();
    expect(view.html).toContain('href="https://typesafe.ai"');
    fixture.api.mockResolvedValueOnce(openrouter());
    choose(view.pick("openrouter")!);
    await flush();
    view = render();
    expect(view.model).toBeDefined();
    expect(view.key!.props["aria-label"]).toBe("OpenRouter API key");
    expect(view.html).not.toContain("typesafe.ai");
    fixture.api.mockResolvedValueOnce(status({ provider: "custom", chosen: "custom" }));
    choose(view.pick("custom")!);
    await flush();
    view = render();
    expect(view.html).toContain('data-testid="decider-custom-base-url"');
    expect(view.key!.props["aria-label"]).toBe("Endpoint API key");
    expect(view.model).toBeUndefined();
  });

  it("marks each provider with its own key saved, and has one status line, one Test and one Save", () => {
    fixture.config = status({ chosen: "jev", configured: true, enabled: true }, { own: { jev: true, workersAi: true } });
    const view = render();
    expect(count(view.html, ">Saved<")).toBe(2);
    expect(count(view.html, 'data-testid="decider-status"')).toBe(1);
    expect(view.byTestId("decider-test")).toHaveLength(1);
    expect(view.byTestId("decider-save")).toHaveLength(1);
    expect(view.html).toContain("Connected");
    expect(view.html).toContain("Clear");
  });

  it("lists only the jobs that work: no coming-soon rows", () => {
    const view = render();
    for (const label of ["Browser clicks", "Tool selection", "Where work runs", "Coming soon"]) expect(view.html).not.toContain(label);
    expect(view.switches).toHaveLength(2);
  });

  it("every button shows a pointer cursor", () => {
    const view = render();
    for (const node of [view.save!, view.test, view.master, view.job]) expect(String(node.props.className)).toContain("cursor-pointer");
  });

  it("the master switch and the job switch patch the config", async () => {
    fixture.config = status({ configured: true, enabled: true });
    fixture.api.mockResolvedValue(fixture.config);
    click(render().master);
    await flush();
    expect(fixture.api).toHaveBeenLastCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { enabled: false } }) });
    fixture.config = status({ configured: true, enabled: true });
    click(render().job);
    await flush();
    expect(fixture.api).toHaveBeenLastCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { jobs: { roomRouting: false } } }) });
  });

  describe("with Cloudflare Workers AI", () => {
    it("refuses a token without a valid account ID, and sends nothing", async () => {
      type(render().key!, "cf-token");
      click(render().save!);
      await flush();
      expect(fixture.api).not.toHaveBeenCalled();
      expect(render().html).toContain("Add your account ID with the token.");
      click(render().test);
      await flush();
      expect(fixture.api).not.toHaveBeenCalled();
    });

    it("saves the pick and the account ID first, then the token, and never renders the token back", async () => {
      fixture.config = status({}, {});
      type(render().account!, ACCOUNT);
      type(render().key!, KEY);
      fixture.api
        .mockResolvedValueOnce(status({ chosen: "workersai" }, { workersAiAccountId: ACCOUNT }))
        .mockResolvedValueOnce(status({ provider: "workersai", chosen: "workersai", configured: true, enabled: true }, { own: { workersAi: true }, workersAiAccountId: ACCOUNT }));
      click(render().save!);
      await flush();
      expect(fixture.api.mock.calls).toEqual([
        ["/api/config", { method: "PUT", body: JSON.stringify({ decider: { provider: "workersai", workersAiAccountId: ACCOUNT } }) }],
        ["/api/config", { method: "PUT", body: JSON.stringify({ decider: { workersAiToken: KEY } }) }],
      ]);
      const view = render();
      expect(view.html).not.toContain(KEY);
      expect(view.html).toContain("Connected");
      expect(view.account!.props.value).toBe(ACCOUNT);
      expect(view.key!.props.value).toBe("");
      expect(view.master.props.checked).toBe(true);
    });

    it("on the desktop the token goes to the credential store under its own name", async () => {
      const setCredential = vi.fn().mockResolvedValue(status({ provider: "workersai", chosen: "workersai", configured: true }, { own: { workersAi: true } }));
      vi.stubGlobal("window", { ogb: { setCredential } });
      fixture.config = status({ chosen: "workersai" }, { workersAiAccountId: ACCOUNT });
      type(render().key!, KEY);
      click(render().save!);
      await flush();
      expect(setCredential).toHaveBeenCalledWith("workersAiToken", KEY);
      expect(fixture.api).not.toHaveBeenCalled();
    });

    it("Test checks Cloudflare only, says how fast, and whether extraction works too", async () => {
      fixture.config = status({ provider: "workersai", chosen: "workersai", configured: true, enabled: true }, { own: { workersAi: true }, workersAiAccountId: ACCOUNT });
      fixture.api.mockResolvedValueOnce({ ok: true, latencyMs: 120, extraction: { ok: true } });
      click(render().test);
      await flush();
      expect(fixture.api).toHaveBeenLastCalledWith("/api/decider/test", { method: "POST", body: JSON.stringify({ provider: "workersai" }) });
      expect(render().html).toContain("Cloudflare answered in 120 ms. Extraction works too.");
      fixture.api.mockResolvedValueOnce({ ok: false, reason: "rejected", status: 401 });
      type(render().key!, "cf-draft");
      click(render().test);
      await flush();
      expect(fixture.api).toHaveBeenLastCalledWith("/api/decider/test", { method: "POST", body: JSON.stringify({ provider: "workersai", key: "cf-draft", accountId: ACCOUNT }) });
      expect(render().html).toContain("Cloudflare didn&#x27;t accept this token.");
    });
  });

  describe("with Jev", () => {
    beforeEach(() => { fixture.config = status({ chosen: "jev" }, {}); });

    it("saves the key in Jev's slot, shows Connected, and never renders the key back", async () => {
      fixture.api.mockResolvedValueOnce(status({ chosen: "jev", configured: true, enabled: true }, { own: { jev: true } }));
      type(render().key!, KEY);
      click(render().save!);
      await flush();
      expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { key: KEY } }) });
      const view = render();
      expect(view.html).toContain("Connected");
      expect(view.html).not.toContain(KEY);
      expect(view.key!.props.value).toBe("");
      expect(view.master.props.checked).toBe(true);
    });

    it("an older install that decides with Jev shows Jev picked, and its first save also saves the pick", async () => {
      fixture.config = status({ configured: true, enabled: true }, { own: { jev: true } });
      expect(render().pick("jev")!.props.checked).toBe(true);
      fixture.api.mockResolvedValue(status({ chosen: "jev", configured: true, enabled: true }, { own: { jev: true } }));
      type(render().key!, KEY);
      click(render().save!);
      await flush();
      expect(fixture.api.mock.calls.map(([, init]) => (init as { body: string }).body)).toEqual([
        JSON.stringify({ decider: { provider: "jev" } }), JSON.stringify({ decider: { key: KEY } }),
      ]);
    });

    it("Test checks Jev only: how fast on success, a fixed sentence on failure", async () => {
      fixture.config = status({ chosen: "jev", configured: true, enabled: true }, { own: { jev: true } });
      fixture.api.mockResolvedValueOnce({ ok: true, latencyMs: 342 });
      click(render().test);
      await flush();
      expect(fixture.api).toHaveBeenCalledWith("/api/decider/test", { method: "POST", body: JSON.stringify({ provider: "jev" }) });
      expect(render().html).toContain("Jev answered in 342 ms.");
      fixture.api.mockResolvedValueOnce({ ok: false, reason: "rejected", status: 401 });
      type(render().key!, "tsk_draft");
      click(render().test);
      await flush();
      expect(fixture.api).toHaveBeenLastCalledWith("/api/decider/test", { method: "POST", body: JSON.stringify({ provider: "jev", key: "tsk_draft" }) });
      expect(render().html).toContain("Jev rejected this key. Check it at typesafe.ai.");
    });

    it("keeps a picked Jev while the shared OpenRouter key decides, and names that key in the status line", () => {
      fixture.config = status({ ...SHARED, provider: "openrouter", chosen: "jev", enabled: true }, { sharedKey: true });
      const view = render();
      expect(view.pick("jev")!.props.checked).toBe(true);
      expect(view.key!.props["aria-label"]).toBe("Jev API key");
      expect(view.key!.props.placeholder).toBe("Paste your TypeSafe API key");
      expect(view.html).toContain("Decisions: your OpenRouter key");
      expect(view.html).toContain("Not set up");
      expect(view.html).not.toContain("Clear");
      expect(view.test.props.disabled).toBe(true);
    });
  });

  describe("with the Cloud plan's included decisions", () => {
    beforeEach(() => { fixture.config = status({ configured: true, included: true, includedAvailable: true, enabled: true }, {}); });

    it("shows them picked, on, with nothing to save or clear", () => {
      const view = render();
      expect(view.pick("included")!.props.checked).toBe(true);
      expect(view.html).toContain("Included with your Cloud plan");
      expect(view.html).toContain("Connected");
      expect(view.html).not.toContain("Save a key below to turn this on.");
      expect(view.master.props.checked).toBe(true);
      expect(view.master.props.disabled).toBe(false);
      expect(view.job.props.checked).toBe(true);
      expect(view.html).not.toContain("Clear");
      expect(view.save).toBeUndefined();
      expect(view.key).toBeUndefined();
      expect(view.test.props.disabled).toBe(false);
    });

    it("Test checks the included decisions, and says what a refusal from the plan means", async () => {
      fixture.api.mockResolvedValueOnce({ ok: true, latencyMs: 210 });
      click(render().test);
      await flush();
      expect(fixture.api).toHaveBeenLastCalledWith("/api/decider/test", { method: "POST", body: "{}" });
      expect(render().html).toContain("Your Cloud plan answered in 210 ms.");
      for (const [result, text] of [
        [{ ok: false, reason: "http_error", status: 402 }, "Decisions are included with an active Cloud subscription."],
        [{ ok: false, reason: "rate_limited", status: 429 }, "Your Cloud plan&#x27;s decisions are busy or used up for this month. Try again later."],
        [{ ok: false, reason: "rejected", status: 401 }, "Seira Cloud did not accept this machine&#x27;s decisions. Try again later."],
      ] as const) {
        fixture.api.mockResolvedValueOnce(result);
        click(render().test);
        await flush();
        expect(render().html).toContain(text);
        expect(render().html).not.toContain("typesafe.ai.");
      }
    });

    it("an own key saved as well is marked Saved, and picking it saves the pick", async () => {
      fixture.config = status({ configured: true, included: true, includedAvailable: true, enabled: true }, { own: { jev: true } });
      expect(count(render().html, ">Saved<")).toBe(1);
      fixture.api.mockResolvedValueOnce(status({ chosen: "jev", configured: true, includedAvailable: true, enabled: true }, { own: { jev: true } }));
      choose(render().pick("jev")!);
      await flush();
      expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { provider: "jev" } }) });
      const view = render();
      expect(view.html).toContain("Connected");
      expect(view.html).toContain("Clear");
    });
  });

  it("a Gemini key saved for speech or images is switchable here, and the picker still shows a real provider", () => {
    fixture.config = status({ provider: "gemini", configured: true, enabled: false }, {});
    const view = render();
    expect(view.master.props.disabled).toBe(false);
    expect(view.pick("workersai")!.props.checked).toBe(true);
    expect(view.html).toContain("Decisions: your Gemini key");
    expect(view.save!.props.disabled).toBe(true);
    expect(view.html).not.toContain("Clear");
  });

  it("maps every failure to a fixed sentence", () => {
    expect(deciderFailureText({ reason: "rejected" }, false, "jev")).toBe("Jev rejected this key. Check it at typesafe.ai.");
    expect(deciderFailureText({ reason: "overloaded" })).toBe("Jev is overloaded right now. Try again shortly.");
    expect(deciderFailureText({ reason: "http_error", status: 500 })).toBe("Jev sent back an error (500). Try again in a moment.");
    expect(deciderFailureText({ reason: "something-new" })).toBe("The test did not finish. Try again.");
    expect(deciderFailureText({ reason: "http_error", status: 503 }, false, "workersai")).toBe("Cloudflare sent back an error (503). Try again in a moment.");
  });

  describe("reads every saved pick the way older versions saved it", () => {
    it.each([
      ["no pick, nothing set up", status(), "workersai"],
      ["no pick, Jev deciding", status({ configured: true }), "jev"],
      ["no pick, Workers AI deciding", status({ provider: "workersai", configured: true }), "workersai"],
      ["no pick, OpenRouter deciding", status({ provider: "openrouter", configured: true }), "openrouter"],
      ["no pick, the plan deciding", status({ configured: true, included: true }), "included"],
      ["Jev picked", status({ chosen: "jev" }), "jev"],
      ["OpenRouter picked, Gemini standing in", status({ provider: "gemini", chosen: "openrouter", configured: true }), "openrouter"],
      ["custom endpoint picked, not set up", status({ provider: "custom", chosen: "custom" }), "custom"],
      ["custom endpoint from an older server", status({ provider: "custom" }), "custom"],
      ["included picked after the plan ended", status({ chosen: "included" }), "workersai"],
    ] as const)("%s", (_, config, picked) => {
      expect(pickedProvider(config)).toBe(picked);
    });
  });

  describe("with a custom endpoint", () => {
    it("asks for its base URL, model and protocol, and saves its key in its own slot", async () => {
      fixture.config = status({ provider: "custom", chosen: "custom", model: "m-1", api: "decisions", baseUrl: "https://gw.example.com/v1" });
      const view = render();
      expect(view.html).toContain('value="https://gw.example.com/v1"');
      expect(view.html).toContain('value="m-1"');
      expect(view.html).toContain("Endpoint API key");
      expect(view.html).not.toContain("typesafe.ai");
      fixture.api.mockResolvedValue(fixture.config);
      type(view.key!, "gw-key");
      click(render().save!);
      await flush();
      expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { customKey: "gw-key" } }) });
      expect(deciderFailureText({ reason: "malformed" }, false, "custom")).toContain("Check the protocol and model ID.");
      expect(deciderFailureText({ reason: "http_error", status: 500 }, false, "custom")).toBe("Your endpoint sent back an error (500).");
    });

    it("offers OpenAI-compatible chat as a protocol and saves it", async () => {
      fixture.config = status({ provider: "custom", chosen: "custom", model: "gemini-2.5-flash", api: "chat", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", configured: true, enabled: true });
      const view = render();
      expect(optionsOf(view.customApi!)).toEqual(["systemone", "decisions", "chat"]);
      expect(view.customApi!.props.value).toBe("chat");
      expect(view.html).toContain("OpenAI-compatible chat");
      fixture.api.mockResolvedValue(fixture.config);
      change(view.customApi!, "decisions");
      await flush();
      expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { customApi: "decisions" } }) });
    });

    it("Test checks the endpoint only", async () => {
      fixture.config = status({ provider: "custom", chosen: "custom", model: "m-1", baseUrl: "https://gw.example.com/v1", configured: true, enabled: true });
      fixture.api.mockResolvedValueOnce({ ok: true, latencyMs: 90 });
      click(render().test);
      await flush();
      expect(fixture.api).toHaveBeenCalledWith("/api/decider/test", { method: "POST", body: JSON.stringify({ provider: "custom" }) });
      expect(render().html).toContain("Your endpoint answered in 90 ms.");
    });
  });

  describe("with OpenRouter", () => {
    beforeEach(() => { fixture.config = openrouter(); });

    it("shows OpenRouter's key, link and model picker, and not Jev's", () => {
      const view = render();
      for (const text of ["OpenRouter API key", "Get a key at openrouter.ai", "Not set up"]) expect(view.html).toContain(text);
      expect(view.html).toContain('href="https://openrouter.ai/keys"');
      expect(view.html).not.toContain("typesafe.ai");
      expect(view.key!.props.placeholder).toBe("Paste your OpenRouter API key");
      expect(view.model).toBeDefined();
      expect(view.master.props.disabled).toBe(true);
    });

    it("loads the model list once, in recommended and more groups, and keeps an off-list saved model", async () => {
      fixture.api.mockResolvedValue(MODELS);
      expect(optionsOf(render().model!)).toEqual(["openai/gpt-4.1-nano"]);
      runEffects();
      await flush();
      expect(fixture.api).toHaveBeenCalledWith("/api/decider/models");
      let view = render();
      expect(optionsOf(view.model!)).toEqual(["openai/gpt-4.1-nano", "meta-llama/llama-3.3-70b-instruct", "acme/zippy"]);
      expect(view.html).toContain("Recommended");
      expect(view.html).toContain("More models");
      expect(view.html).not.toContain("built-in list");
      runEffects();
      expect(fixture.api).toHaveBeenCalledTimes(1);
      fixture.config = openrouter({ model: "newvendor/brand-new" });
      view = render();
      expect(view.model!.props.value).toBe("newvendor/brand-new");
      expect(optionsOf(view.model!)).toEqual(["newvendor/brand-new", "openai/gpt-4.1-nano", "meta-llama/llama-3.3-70b-instruct", "acme/zippy"]);
    });

    it("loads no model list for another provider", () => {
      fixture.config = status();
      render();
      runEffects();
      expect(fixture.api).not.toHaveBeenCalled();
    });

    it("says when only the built-in list could be loaded, and survives a failed load", async () => {
      fixture.api.mockResolvedValueOnce({ ...MODELS, source: "builtin" });
      render();
      runEffects();
      await flush();
      expect(render().html).toContain("OpenRouter&#x27;s model catalog could not be loaded, so this is the built-in list.");
      fixture.values = [];
      fixture.api.mockRejectedValueOnce(new Error("offline"));
      render();
      runEffects();
      await flush();
      const view = render();
      expect(optionsOf(view.model!)).toEqual(["openai/gpt-4.1-nano"]);
      expect(view.html).not.toContain("built-in list");
    });

    it("choosing a model saves it", async () => {
      fixture.api.mockResolvedValueOnce(openrouter({ model: "acme/zippy" }));
      change(render().model!, "acme/zippy");
      await flush();
      expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { openrouterModel: "acme/zippy", openrouterApi: "chat" } }) });
      expect(render().model!.props.value).toBe("acme/zippy");
    });

    it("saves the key on the server path, shows Connected and never renders the key back", async () => {
      fixture.api.mockResolvedValueOnce(openrouter({ configured: true, keySource: "own", enabled: true }));
      type(render().key!, KEY);
      click(render().save!);
      await flush();
      expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { openrouterKey: KEY } }) });
      const view = render();
      expect(view.html).toContain("Connected");
      expect(view.html).not.toContain(KEY);
      expect(view.key!.props.value).toBe("");
      expect(view.master.props.checked).toBe(true);
    });

    it("on the desktop the key goes to the credential store under its own name", async () => {
      const setCredential = vi.fn().mockResolvedValue(openrouter({ configured: true, keySource: "own", enabled: true }));
      vi.stubGlobal("window", { ogb: { setCredential } });
      type(render().key!, KEY);
      click(render().save!);
      await flush();
      expect(setCredential).toHaveBeenCalledWith("openrouterDeciderKey", KEY);
      expect(fixture.api).not.toHaveBeenCalled();
    });

    it("Test names OpenRouter, and warns when the answer is slower than a room may wait", async () => {
      fixture.config = openrouter({ configured: true, keySource: "own", enabled: true });
      fixture.api.mockResolvedValueOnce({ ok: true, latencyMs: 342 });
      click(render().test);
      await flush();
      expect(fixture.api).toHaveBeenCalledWith("/api/decider/test", { method: "POST", body: JSON.stringify({ provider: "openrouter" }) });
      let html = render().html;
      expect(html).toContain("OpenRouter answered in 342 ms.");
      expect(html).not.toContain("slower than");
      fixture.api.mockResolvedValueOnce({ ok: true, latencyMs: 2100 });
      click(render().test);
      await flush();
      html = render().html;
      expect(html).toContain("OpenRouter answered in 2100 ms.");
      expect(html).toContain("slower than the 1.5 s a room decision may take");
      fixture.api.mockResolvedValueOnce({ ok: false, reason: "rejected", status: 401 });
      type(render().key!, "sk-or-draft");
      click(render().test);
      await flush();
      expect(fixture.api).toHaveBeenLastCalledWith("/api/decider/test", { method: "POST", body: JSON.stringify({ provider: "openrouter", key: "sk-or-draft" }) });
      expect(render().html).toContain("OpenRouter rejected this key. Check it at openrouter.ai/keys.");
    });

    describe("with the OpenRouter key from API keys", () => {
      it("uses it with nothing to enter: labelled, linked, switchable, with no key to clear", async () => {
        fixture.config = openrouter(SHARED);
        const view = render();
        expect(view.html).toContain("Using your OpenRouter API key");
        expect(view.html).toContain("Shared with your OpenRouter models");
        expect(view.html).not.toContain("Not set up");
        expect(view.html).not.toContain("Get a key at openrouter.ai");
        expect(view.master.props.disabled).toBe(false);
        expect(view.save!.props.disabled).toBe(true);
        expect(view.html).not.toContain("Clear");
        expect(view.key!.props.placeholder).toBe("Use a different key (optional)");
        expect(view.test.props.disabled).toBe(false);
        fixture.api.mockResolvedValueOnce(openrouter({ ...SHARED, enabled: true }));
        click(view.master);
        await flush();
        expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { enabled: true } }) });
      });

      it("links to where the key is managed", () => {
        fixture.config = openrouter(SHARED);
        fixture.dispatch.mockReset();
        click(render().manage!);
        expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "toggleAppSettings", open: true, section: "connections" });
      });

      it("Test checks the shared key without sending one, and a pasted key still saves as the override", async () => {
        fixture.config = openrouter(SHARED);
        fixture.api.mockResolvedValueOnce({ ok: true, latencyMs: 280 });
        click(render().test);
        await flush();
        expect(fixture.api).toHaveBeenCalledWith("/api/decider/test", { method: "POST", body: JSON.stringify({ provider: "openrouter" }) });
        expect(render().html).toContain("OpenRouter answered in 280 ms with your shared key.");
        fixture.api.mockResolvedValueOnce(openrouter({ ...SHARED, keySource: "own" }));
        type(render().key!, KEY);
        click(render().save!);
        await flush();
        expect(fixture.api).toHaveBeenLastCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { openrouterKey: KEY } }) });
        expect(render().html).not.toContain(KEY);
      });

      it("a separate saved key shows as such, can be replaced or cleared, and says what clearing does", async () => {
        fixture.config = openrouter({ ...SHARED, keySource: "own", enabled: true });
        const view = render();
        expect(view.html).toContain("Connected (separate key)");
        expect(view.html).toContain("Clear this key to use your shared OpenRouter API key instead.");
        expect(view.html).not.toContain("Using your OpenRouter API key");
        expect(view.manage).toBeUndefined();
        expect(view.key!.props.placeholder).toBe("••••••••  (paste to replace)");
        expect(view.html).toContain("Clear");
        expect(view.save!.props.disabled).toBe(false);
        fixture.api.mockResolvedValueOnce(openrouter({ ...SHARED, enabled: true }));
        click(view.save!);
        await flush();
        expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { openrouterKey: "" } }) });
        expect(render().html).toContain("Using your OpenRouter API key");
      });

      it("with no key anywhere, asks for one and points to API keys", () => {
        const view = render();
        expect(view.html).toContain("Not set up");
        expect(view.html).toContain("Save an OpenRouter key under API keys to use it here and for models");
        expect(view.manage).toBeDefined();
        expect(view.master.props.disabled).toBe(true);
        expect(view.test.props.disabled).toBe(true);
      });

      it("a separate key with nothing shared reads as plain Connected", () => {
        fixture.config = openrouter({ configured: true, keySource: "own", enabled: true });
        const view = render();
        expect(view.html).toContain("Connected");
        expect(view.html).not.toContain("separate key");
        expect(view.html).not.toContain("shared OpenRouter API key");
        expect(view.manage).toBeUndefined();
      });
    });

    it("maps every OpenRouter failure to a fixed sentence", () => {
      const text = (result: { reason: string; status?: number }) => deciderFailureText(result, false, "openrouter");
      expect(text({ reason: "rejected", status: 401 })).toBe("OpenRouter rejected this key. Check it at openrouter.ai/keys.");
      expect(text({ reason: "http_error", status: 402 })).toBe("Your OpenRouter account is out of credits. Add some at openrouter.ai/credits.");
      expect(text({ reason: "http_error", status: 500 })).toBe("OpenRouter sent back an error (500). Try again in a moment.");
      expect(text({ reason: "rate_limited" })).toBe("OpenRouter is limiting requests right now. Try again in a moment.");
      expect(text({ reason: "overloaded" })).toBe("The model is overloaded right now. Try again shortly.");
      expect(text({ reason: "malformed" })).toBe("The model sent an answer Seira could not read. Try another model.");
      expect(text({ reason: "unreachable" })).toBe("Could not reach OpenRouter. Check your connection.");
      expect(text({ reason: "timeout" })).toBe("OpenRouter did not answer in time. Try again.");
      expect(text({ reason: "no_key" })).toBe("Paste a key or save one first.");
      expect(text({ reason: "something-new" })).toBe("The test did not finish. Try again.");
      expect(deciderFailureText({ reason: "http_error", status: 402 })).toBe("Jev sent back an error (402). Try again in a moment.");
    });
  });
});
