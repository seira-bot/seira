import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigStatus, InstanceInfo } from "@/state/store";
import type { EngineLimit } from "@/lib/limit-resets";
import { AiPoolSettings } from "./AiPoolSettings";
import { AddRows, MemberRows } from "./AiPoolMembers";
import { SettingsLook, Switch } from "./SettingsPrimitives";

const fixture = vi.hoisted(() => ({
  values: [] as unknown[], index: 0,
  config: {} as Pick<ConfigStatus, "aiPool">,
  instances: [] as InstanceInfo[],
  bots: [] as { id: string; name: string; modelSelection: { instanceId: string; model: string } }[],
  limits: [] as EngineLimit[],
  api: vi.fn(), dispatch: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = initial;
    return [fixture.values[index], (next: unknown) => { fixture.values[index] = next; }];
  },
  useRef: (initial: unknown) => {
    const index = fixture.index++;
    return fixture.values[index] ??= { current: initial };
  },
}));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({ state: { config: fixture.config, instances: fixture.instances, bots: fixture.bots }, dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/limit-resets", async (original) => ({
  ...await original<typeof import("@/lib/limit-resets")>(),
  useEngineLimits: () => fixture.limits,
}));

const NEEDS_SECOND = 4;
const FOLD = 5;
const REVIEW = 6;

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    if (typeof node.type === "function" && node.type.name === "ModeChoice") return [node, ...nodes((node.type as (props: unknown) => ReactNode)(node.props))];
    if (node.type === MemberRows || node.type === AddRows) return [node, ...nodes((node.type as (props: unknown) => ReactNode)(node.props))];
    return [node, ...nodes(node.props.children)];
  });
}
function render() {
  let tree: ReactNode = null;
  function Capture() { fixture.index = 0; tree = AiPoolSettings(); return tree; }
  const html = renderToStaticMarkup(createElement(SettingsLook.Provider, { value: true }, createElement(Capture)));
  const all = nodes(tree);
  const byId = (id: string) => all.find((node) => node.props.id === id);
  const button = (label: string) => all.find((node) => node.type === "button" && node.props["aria-label"] === label);
  const radio = (label: string) => all.find((node) => node.type === "button" && node.props.role === "radio" && node.props.children === label);
  return { html, toggle: all.find((node) => node.type === Switch)!, byId, button, radio, all };
}
const click = (node: Node | undefined) => (node!.props.onClick as () => void)();
const choose = (node: Node | undefined, value: string) => (node!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const sent = (call = 0) => JSON.parse((fixture.api.mock.calls[call]![1] as { body: string }).body) as { aiPool: Record<string, unknown> };

const claude = { instanceId: "claude", model: "claude-m" };
const codex = { instanceId: "codex", model: "codex-m" };
const gemini = { instanceId: "gemini", model: "gemini-m" };
const engine = (id: string, name: string, kind = "codex", extra: Partial<InstanceInfo> = {}): InstanceInfo => ({
  instanceId: id, driverKind: kind, displayName: name, access: "subscription",
  snapshot: { state: "available", authenticated: true }, models: { default: `${id}-m`, options: [{ id: `${id}-m`, label: `${name} model` }] },
  ...extra,
});
const limit = (id: string, usedPercent: number): EngineLimit => ({ engine: id, name: id, driver: "codex", window: null, usedPercent, resetsAt: null, blocked: false } as EngineLimit);

beforeEach(() => {
  fixture.values = [];
  fixture.config = {};
  fixture.limits = [];
  fixture.bots = [];
  fixture.instances = [engine("claude", "Claude", "claudeAgent"), engine("codex", "Codex", "codex"), engine("gemini", "Gemini", "antigravityAgent")];
  fixture.api.mockReset();
  fixture.dispatch.mockReset().mockImplementation((action: { type: string; config?: ConfigStatus }) => { if (action.config) fixture.config = action.config; });
});

describe("AiPoolSettings", () => {
  it("starts off with one short line and no other control", () => {
    const view = render();
    expect(view.toggle.props.checked).toBe(false);
    expect(view.toggle.props["aria-label"]).toBe("Share usage across AIs");
    expect(view.html).toContain("Your bots share usage across several AIs");
    expect(view.radio("Balance usage")).toBeUndefined();
    expect(view.html).not.toContain("How to share");
  });

  it("turns on with the AIs that are signed in, keeping one sign-in per plan", async () => {
    fixture.instances.push(engine("claude2", "Claude 2", "claudeAgent"));
    fixture.limits = [limit("claude", 50), limit("codex", 10), limit("gemini", 90), limit("claude2", 20)];
    fixture.api.mockResolvedValueOnce({ aiPool: { enabled: true, mode: "even", members: [codex, claude, gemini] } });
    click(render().toggle);
    await flush();
    expect(fixture.api.mock.calls[0]![0]).toBe("/api/config");
    expect(sent().aiPool.enabled).toBe(true);
    expect((sent().aiPool.members as { instanceId: string }[]).map((m) => m.instanceId)).toEqual(["codex", "claude2", "gemini"]);
  });

  describe("pay-per-use AIs", () => {
    const key = { instanceId: "key", model: "key-m" };
    const paidKey = () => engine("key", "Key", "grokAgent", { access: "api" });
    const button = (view: ReturnType<typeof render>, label: string) => view.all.find((node) => node.type === "button" && node.props.children === label);

    it("does not save on turn-on and asks first when a pay-per-use AI is ready", () => {
      fixture.instances.push(paidKey());
      click(render().toggle);
      expect(fixture.api).not.toHaveBeenCalled();
      expect(fixture.values[REVIEW]).toMatchObject({ plans: [{ instanceId: "claude" }, { instanceId: "codex" }, { instanceId: "gemini" }], paid: [key] });
      const html = render().html;
      expect(html).toContain("Include pay-per-use AIs?");
      expect(html).toContain("Plans: Claude, Codex, Gemini.");
      expect(html).toContain("Pay per use: Key.");
      expect(html).toContain("billed to your account");
      expect(html).toContain("only when no plan AI has usage left");
    });

    it("saves the plans and the pay-per-use AI only after the owner includes it", async () => {
      fixture.instances.push(paidKey());
      click(render().toggle);
      fixture.api.mockResolvedValueOnce({ aiPool: { enabled: true, mode: "even", members: [] } });
      click(button(render(), "Include pay per use"));
      await flush();
      expect(sent().aiPool.enabled).toBe(true);
      expect((sent().aiPool.members as { instanceId: string }[]).map((m) => m.instanceId)).toEqual(["claude", "codex", "gemini", "key"]);
      expect(fixture.values[REVIEW]).toBeNull();
    });

    it("saves the plans alone when the owner declines pay per use", async () => {
      fixture.instances.push(paidKey());
      click(render().toggle);
      fixture.api.mockResolvedValueOnce({ aiPool: { enabled: true, mode: "even", members: [] } });
      click(button(render(), "Plans only"));
      await flush();
      expect((sent().aiPool.members as { instanceId: string }[]).map((m) => m.instanceId)).toEqual(["claude", "codex", "gemini"]);
    });

    it("does not save when declining leaves fewer than two plans", () => {
      fixture.instances = [engine("codex", "Codex"), paidKey()];
      click(render().toggle);
      click(button(render(), "Plans only"));
      expect(fixture.api).not.toHaveBeenCalled();
      expect(fixture.values[NEEDS_SECOND]).toBe(true);
      expect(fixture.values[REVIEW]).toBeNull();
    });

    it("asks again before a saved pool with a pay-per-use AI turns back on", async () => {
      fixture.instances.push(paidKey());
      fixture.config = { aiPool: { enabled: false, mode: "turns", members: [codex, key, claude] } };
      click(render().toggle);
      expect(fixture.api).not.toHaveBeenCalled();
      expect(render().html).toContain("A pay-per-use AI is used only when no plan AI can take the turn.");
      fixture.api.mockResolvedValueOnce({ aiPool: { enabled: true, mode: "turns", members: [codex, claude] } });
      click(button(render(), "Plans only"));
      await flush();
      expect(sent()).toEqual({ aiPool: { enabled: true, mode: "turns", members: [codex, claude] } });
    });

    it("keeps the saved order when a saved pool is turned on with pay per use", async () => {
      fixture.instances.push(paidKey());
      fixture.config = { aiPool: { enabled: false, mode: "inOrder", members: [key, codex, claude] } };
      click(render().toggle);
      fixture.api.mockResolvedValueOnce({ aiPool: { enabled: true, mode: "inOrder", members: [key, codex, claude] } });
      click(button(render(), "Include pay per use"));
      await flush();
      expect(sent()).toEqual({ aiPool: { enabled: true, mode: "inOrder", members: [key, codex, claude] } });
    });

    it("turns a saved pool with plans only on at once", async () => {
      fixture.instances.push(paidKey());
      fixture.config = { aiPool: { enabled: false, mode: "even", members: [claude, codex] } };
      fixture.api.mockResolvedValueOnce({ aiPool: { enabled: true, mode: "even", members: [claude, codex] } });
      click(render().toggle);
      await flush();
      expect(fixture.values[REVIEW]).toBeNull();
      expect(sent()).toEqual({ aiPool: { enabled: true, mode: "even", members: [claude, codex] } });
    });

    it("does not turn on while the billing of a member is unknown, and says which", () => {
      fixture.instances.push(paidKey(), engine("mystery", "Mystery", "codex", { access: undefined }));
      fixture.config = { aiPool: { enabled: false, mode: "even", members: [claude, codex, { instanceId: "mystery", model: "mystery-m" }] } };
      click(render().toggle);
      expect(fixture.api).not.toHaveBeenCalled();
      expect(fixture.values[REVIEW]).toBeNull();
      expect(render().html).toContain("Pay-per-use status is unknown for Mystery");
    });

    it("does not turn on a saved pool whose AI is gone, even when the rest are plans", () => {
      fixture.config = { aiPool: { enabled: false, mode: "even", members: [claude, codex, { instanceId: "gone", model: "m" }] } };
      click(render().toggle);
      expect(fixture.api).not.toHaveBeenCalled();
      expect(render().html).toContain("Pay-per-use status is unknown for gone");
    });

    it("leaves an AI that does not report its billing out of the suggested list", async () => {
      fixture.instances.push(engine("mystery", "Mystery", "codex", { access: undefined }));
      fixture.api.mockResolvedValueOnce({ aiPool: { enabled: true, mode: "even", members: [] } });
      click(render().toggle);
      await flush();
      expect((sent().aiPool.members as { instanceId: string }[]).map((m) => m.instanceId)).toEqual(["claude", "codex", "gemini"]);
    });

    it("shows the new list when the AIs change while the question is open, and saves only what was shown", async () => {
      fixture.instances.push(paidKey());
      click(render().toggle);
      expect(render().html).toContain("Pay per use: Key.");
      fixture.instances.push(engine("key2", "Second key", "grokAgent", { access: "api" }));
      expect(render().html).toContain("Pay per use: Key, Second key.");
      fixture.api.mockResolvedValueOnce({ aiPool: { enabled: true, mode: "even", members: [] } });
      click(button(render(), "Include pay per use"));
      await flush();
      expect((sent().aiPool.members as { instanceId: string }[]).map((m) => m.instanceId)).toEqual(["claude", "codex", "gemini", "key", "key2"]);
    });

    it("closes the question and saves nothing when the pay-per-use AI goes away or its billing turns unknown", () => {
      fixture.instances.push(paidKey());
      click(render().toggle);
      fixture.instances = fixture.instances.filter((instance) => instance.instanceId !== "key");
      expect(render().html).not.toContain("Include pay-per-use AIs?");
      expect(render().html).toContain("The AIs changed while you were choosing.");
      expect(fixture.api).not.toHaveBeenCalled();
    });

    it("offers no choice on a list that has become unknown", () => {
      fixture.instances.push(paidKey());
      fixture.config = { aiPool: { enabled: false, mode: "even", members: [claude, codex, key] } };
      click(render().toggle);
      expect(button(render(), "Include pay per use")).toBeDefined();
      fixture.instances = fixture.instances.map((instance) => (instance.instanceId === "codex" ? { ...instance, access: undefined } : instance));
      expect(render().html).toContain("Pay-per-use status is unknown for Codex");
      expect(render().html).not.toContain("Include pay-per-use AIs?");
      expect(button(render(), "Include pay per use")).toBeUndefined();
      expect(fixture.api).not.toHaveBeenCalled();
    });
  });

  it("with one signed-in AI it does not save and offers to add one", () => {
    fixture.instances = [engine("codex", "Codex")];
    click(render().toggle);
    expect(fixture.api).not.toHaveBeenCalled();
    expect(fixture.values[NEEDS_SECOND]).toBe(true);
    const html = render().html;
    expect(html).toContain("Sign in to a second AI to share usage.");
    expect(html).toContain("Add an AI");
  });

  it("turns off at once", async () => {
    fixture.config = { aiPool: { enabled: true, mode: "even", members: [claude, codex] } };
    fixture.api.mockResolvedValueOnce({ aiPool: { enabled: false, mode: "even", members: [claude, codex] } });
    click(render().toggle);
    await flush();
    expect(sent()).toEqual({ aiPool: { enabled: false, mode: "even", members: [claude, codex] } });
  });

  it("shows the three modes as radios and saves the mode", async () => {
    fixture.config = { aiPool: { enabled: true, mode: "even", members: [claude, codex] } };
    const view = render();
    expect(view.html).toContain('role="radiogroup"');
    expect(view.html).toContain('aria-label="How to share"');
    expect(view.radio("Balance usage")!.props["aria-checked"]).toBe(true);
    expect(view.radio("Take turns")!.props["aria-checked"]).toBe(false);
    expect(view.radio("In order")).toBeDefined();
    fixture.api.mockResolvedValueOnce({ aiPool: { enabled: true, mode: "turns", members: [claude, codex] } });
    click(view.radio("Take turns"));
    await flush();
    expect(sent()).toEqual({ aiPool: { enabled: true, mode: "turns", members: [claude, codex] } });
  });

  it("shows each member with a status line, the next tag and named controls", () => {
    fixture.config = { aiPool: { enabled: true, mode: "even", members: [claude, codex] } };
    fixture.limits = [limit("claude", 70), limit("codex", 20)];
    const view = render();
    expect(view.html).toContain("30% left");
    expect(view.html).toContain("80% left");
    expect(view.html).toContain("Next");
    expect(view.byId("ai-pool-model-claude")!.props["aria-label"]).toBe("Model for Claude");
    expect(view.button("Move Claude up")!.props.disabled).toBe(true);
    expect(view.button("Move Codex down")!.props.disabled).toBe(true);
    expect(view.button("Remove Codex")).toBeDefined();
  });

  it("saves the new order, the model and a removal", async () => {
    fixture.config = { aiPool: { enabled: true, mode: "inOrder", members: [claude, codex, gemini] } };
    fixture.api.mockResolvedValueOnce({ aiPool: { enabled: true, mode: "inOrder", members: [codex, claude, gemini] } });
    click(render().button("Move Codex up"));
    await flush();
    expect(sent(0).aiPool.members).toEqual([codex, claude, gemini]);
    fixture.api.mockResolvedValueOnce({ aiPool: { enabled: true, mode: "inOrder", members: [codex, claude, gemini] } });
    choose(render().byId("ai-pool-model-claude"), "other");
    await flush();
    expect(sent(1).aiPool.members).toEqual([codex, { instanceId: "claude", model: "other" }, gemini]);
    fixture.api.mockResolvedValueOnce({ aiPool: { enabled: true, mode: "inOrder", members: [codex, gemini] } });
    click(render().button("Remove Claude"));
    await flush();
    expect(sent(2).aiPool.members).toEqual([codex, gemini]);
  });

  it("turns the pool off, with a notice, when a removal leaves one AI", async () => {
    fixture.config = { aiPool: { enabled: true, mode: "even", members: [claude, codex] } };
    fixture.api.mockResolvedValueOnce({ aiPool: { enabled: false, mode: "even", members: [claude] } });
    click(render().button("Remove Codex"));
    await flush();
    expect(sent().aiPool).toEqual({ enabled: false, mode: "even", members: [claude] });
    expect(render().html).toContain("The AI pool is off. It needs at least two AIs.");
  });

  it("adds an AI that is not in the pool", async () => {
    fixture.config = { aiPool: { enabled: true, mode: "even", members: [claude, codex] } };
    const view = render();
    expect(view.html).toContain("Add to the pool");
    fixture.api.mockResolvedValueOnce({ aiPool: { enabled: true, mode: "even", members: [claude, codex, gemini] } });
    click(view.button("Add Gemini"));
    await flush();
    expect(sent().aiPool.members).toEqual([claude, codex, gemini]);
  });

  it("dims a second sign-in to a pooled plan with the reason, and swaps on request", async () => {
    fixture.instances.push(engine("claude2", "Claude 2", "claudeAgent"));
    fixture.config = { aiPool: { enabled: true, mode: "even", members: [claude, codex] } };
    const view = render();
    expect(view.html).toContain("Claude is already in the pool. The provider allows one sign-in per plan in a pool.");
    expect(view.button("Add Claude 2")).toBeUndefined();
    fixture.api.mockResolvedValueOnce({ aiPool: { enabled: true, mode: "even", members: [{ instanceId: "claude2", model: "claude2-m" }, codex] } });
    click(view.button("Use Claude 2 instead of Claude"));
    await flush();
    expect(sent().aiPool.members).toEqual([{ instanceId: "claude2", model: "claude2-m" }, codex]);
  });

  it("offers a sign-in, not a swap, for a signed-out second sign-in to a pooled plan", () => {
    fixture.instances.push(engine("claude2", "Claude 2", "claudeAgent", { snapshot: { state: "available", authenticated: false } }));
    fixture.config = { aiPool: { enabled: true, mode: "even", members: [claude, codex] } };
    const view = render();
    expect(view.html).toContain("Claude is already in the pool. The provider allows one sign-in per plan in a pool.");
    expect(view.button("Use Claude 2 instead of Claude")).toBeUndefined();
    click(view.button("Sign in to Claude 2"));
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "engines" });
  });

  it("shows a signed-out AI with a sign-in button that opens providers", () => {
    fixture.instances.push(engine("grok", "Grok", "grokAgent", { snapshot: { state: "available", authenticated: false } }));
    fixture.config = { aiPool: { enabled: true, mode: "even", members: [claude, codex] } };
    const view = render();
    expect(view.html).toContain("Signed out");
    click(view.button("Sign in to Grok"));
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "engines" });
  });

  it("stops offering the add rows at ten AIs", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ instanceId: `e${i}`, model: "m" }));
    fixture.config = { aiPool: { enabled: true, mode: "even", members: many } };
    const view = render();
    expect(view.html).toContain("The pool holds up to 10 AIs.");
    expect(view.button("Add Claude")!.props.disabled).toBe(true);
  });

  it("keeps reserve and steps behind More options, and saves levels that stay above the reserve", async () => {
    fixture.config = { aiPool: { enabled: true, mode: "even", members: [claude, codex] } };
    expect(render().byId("ai-pool-more")!.props.open).toBe(false);
    fixture.values[FOLD] = true;
    const view = render();
    expect(view.byId("ai-pool-reserve")!.props["aria-label"]).toBe("Keep in reserve");
    expect(view.byId("ai-pool-steps")!.props["aria-label"]).toBe("Switch in steps of");
    fixture.api.mockResolvedValueOnce({ aiPool: { enabled: true, mode: "even", members: [claude, codex], floor: 20, levels: [90, 80, 70, 60, 50, 40, 30] } });
    choose(view.byId("ai-pool-reserve"), "20");
    await flush();
    const trimmed = [90, 80, 70, 60, 50, 40, 30];
    expect(sent(0).aiPool).toEqual({ enabled: true, mode: "even", members: [claude, codex], floor: 20, levels: trimmed });
    fixture.api.mockResolvedValueOnce({ aiPool: { enabled: true, mode: "even", members: [claude, codex], floor: 20, levels: [80, 60, 40] } });
    choose(render().byId("ai-pool-steps"), "20");
    await flush();
    expect(sent(1).aiPool).toEqual({ enabled: true, mode: "even", members: [claude, codex], floor: 20, levels: [80, 60, 40] });
  });

  it("hides the steps outside balance mode", () => {
    fixture.config = { aiPool: { enabled: true, mode: "turns", members: [claude, codex] } };
    fixture.values[FOLD] = true;
    const view = render();
    expect(view.byId("ai-pool-reserve")).toBeDefined();
    expect(view.byId("ai-pool-steps")).toBeUndefined();
  });

  it("lists the bots that do not use the pool", () => {
    fixture.config = { aiPool: { enabled: true, mode: "even", members: [claude, codex] } };
    fixture.bots = [
      { id: "b1", name: "Alpha", modelSelection: claude },
      { id: "b2", name: "Beta", modelSelection: gemini },
    ];
    const html = render().html;
    expect(html).toContain("1 of 2 bots");
    expect(html).toContain("Bots not using the pool (1)");
    expect(html).toContain("Beta");
    expect(html).toContain("data-ai-pool-idle");
  });

  it("shows the error and drops the draft when a save fails", async () => {
    fixture.config = { aiPool: { enabled: false, mode: "even", members: [claude, codex] } };
    fixture.api.mockRejectedValueOnce(new Error("Nope"));
    click(render().toggle);
    await flush();
    const view = render();
    expect(view.html).toContain('role="alert"');
    expect(view.html).toContain("Nope");
    expect(view.toggle.props.checked).toBe(false);
  });
});
