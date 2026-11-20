import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigStatus, InstanceInfo } from "@/state/store";
import { AiPoolSettings } from "./AiPoolSettings";
import { Switch } from "./SettingsPrimitives";

const fixture = vi.hoisted(() => ({
  values: [] as unknown[], index: 0,
  config: {} as Pick<ConfigStatus, "aiPool">,
  instances: [] as InstanceInfo[],
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
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { config: fixture.config, instances: fixture.instances }, dispatch: fixture.dispatch }),
}));

const FOLD = 7;
const MORE = 3;

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
  function Capture() { fixture.index = 0; tree = AiPoolSettings(); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  const all = nodes(tree);
  const byId = (id: string) => all.find((node) => node.props.id === id)!;
  return {
    html,
    toggle: all.find((node) => node.type === Switch)!,
    mode: byId("ai-pool-mode"),
    addEngine: byId("ai-pool-add-engine"),
    addModel: byId("ai-pool-add-model"),
    levels: byId("ai-pool-levels"),
    floor: byId("ai-pool-floor"),
    button: (label: string) => all.find((node) => node.type === "button" && node.props["aria-label"] === label)!,
  };
}
const click = (node: Node) => (node.props.onClick as () => void)();
const blur = (node: Node) => (node.props.onBlur as () => void)();
const choose = (node: Node, value: string) => (node.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const sent = (call = 0) => JSON.parse((fixture.api.mock.calls[call]![1] as { body: string }).body) as { aiPool: Record<string, unknown> };

const claude = { instanceId: "claude", model: "c1" };
const codex = { instanceId: "codex", model: "x1" };
const gemini = { instanceId: "gemini", model: "g1" };
const engine = (id: string, name: string, model: string): InstanceInfo => ({
  instanceId: id, driverKind: "codex", displayName: name,
  snapshot: { state: "available", authenticated: true }, models: { default: model, options: [{ id: model, label: `${name} model` }] },
});

beforeEach(() => {
  fixture.values = [];
  fixture.config = {};
  fixture.instances = [engine("claude", "Claude", "c1"), engine("codex", "Codex", "x1"), engine("gemini", "Gemini", "g1")];
  fixture.api.mockReset();
  fixture.dispatch.mockReset().mockImplementation(({ config }: { config: ConfigStatus }) => { fixture.config = config; });
});

describe("AiPoolSettings", () => {
  it("starts off with one short line; Learn more explains both modes, shared plans and pay-per-use keys", () => {
    const view = render();
    expect(view.toggle.props.checked).toBe(false);
    expect(view.mode).toBeUndefined();
    expect(view.addEngine).toBeUndefined();
    expect(view.html).toContain("Use more than one AI for your conversations, so you run out of usage less often.");
    expect(view.html).toContain("Learn more");
    expect(view.html).not.toContain("Two sign-ins");
    fixture.values[MORE] = true;
    const more = render().html;
    expect(more).toContain("Even: a conversation moves to another AI in the pool");
    expect(more).toContain("In order: each turn uses the first AI in the list that has usage left. A conversation goes back to an earlier AI when it has usage left again.");
    expect(more).toContain("Two sign-ins to the same AI plan can&#x27;t share a pool.");
    expect(more).toContain("In even mode, a pay-per-use key is used only when the AIs with a plan are low. A key may cost money.");
  });

  it("turns on and saves at once when two AIs are already in the pool", async () => {
    fixture.config = { aiPool: { enabled: false, mode: "even", members: [claude, codex] } };
    fixture.api.mockResolvedValueOnce({ aiPool: { enabled: true, mode: "even", members: [claude, codex] } });
    click(render().toggle);
    await flush();
    expect(fixture.api).toHaveBeenCalledTimes(1);
    expect(fixture.api.mock.calls[0]![0]).toBe("/api/config");
    expect(sent()).toEqual({ aiPool: { enabled: true, mode: "even", members: [claude, codex] } });
    expect(render().toggle.props.checked).toBe(true);
  });

  it("with one AI it does not save and says what is missing", () => {
    fixture.config = { aiPool: { enabled: false, mode: "even", members: [claude] } };
    click(render().toggle);
    expect(fixture.api).not.toHaveBeenCalled();
    expect(render().toggle.props.checked).toBe(true);
    expect(render().html).toContain("Add at least two AIs.");
  });

  it("adds AIs one at a time, hides the ones already in the list, and saves with the second", async () => {
    click(render().toggle);
    expect(render().html).toContain("Add at least two AIs.");
    choose(render().addEngine, "claude");
    expect(render().html).toContain('aria-label="Model"');
    choose(render().addModel, "c1");
    expect(fixture.api).not.toHaveBeenCalled();
    const view = render();
    expect(view.html).toContain("Claude model");
    expect(view.html).not.toContain('<option value="claude"');
    expect(view.html).toContain('<option value="codex"');
    fixture.api.mockResolvedValueOnce({ aiPool: { enabled: true, mode: "even", members: [claude, codex] } });
    choose(view.addEngine, "codex");
    choose(render().addModel, "x1");
    await flush();
    expect(sent()).toEqual({ aiPool: { enabled: true, mode: "even", members: [claude, codex] } });
  });

  it("stops offering the add row at ten AIs", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ instanceId: `e${i}`, model: "m" }));
    fixture.config = { aiPool: { enabled: true, mode: "even", members: many } };
    const html = render().html;
    expect(html).toContain("The pool holds up to 10 AIs.");
    expect(html).not.toContain('aria-label="Add an AI"');
  });

  it("saves the new order when an AI moves up or down", async () => {
    fixture.config = { aiPool: { enabled: true, mode: "inOrder", members: [claude, codex, gemini] } };
    expect(render().button("Move Claude up").props.disabled).toBe(true);
    expect(render().button("Move Gemini down").props.disabled).toBe(true);
    fixture.api.mockResolvedValueOnce({ aiPool: { enabled: true, mode: "inOrder", members: [codex, claude, gemini] } });
    click(render().button("Move Codex up"));
    await flush();
    expect(sent(0)).toEqual({ aiPool: { enabled: true, mode: "inOrder", members: [codex, claude, gemini] } });
    fixture.api.mockResolvedValueOnce({ aiPool: { enabled: true, mode: "inOrder", members: [codex, gemini, claude] } });
    click(render().button("Move Claude down"));
    await flush();
    expect(sent(1)).toEqual({ aiPool: { enabled: true, mode: "inOrder", members: [codex, gemini, claude] } });
  });

  it("removes an AI, and does not save a pool left with one", async () => {
    fixture.config = { aiPool: { enabled: true, mode: "even", members: [claude, codex, gemini] } };
    fixture.api.mockResolvedValueOnce({ aiPool: { enabled: true, mode: "even", members: [claude, gemini] } });
    click(render().button("Remove Codex"));
    await flush();
    expect(sent()).toEqual({ aiPool: { enabled: true, mode: "even", members: [claude, gemini] } });
    click(render().button("Remove Gemini"));
    expect(fixture.api).toHaveBeenCalledTimes(1);
    expect(render().html).toContain("Add at least two AIs.");
  });

  it("saves the mode", async () => {
    fixture.config = { aiPool: { enabled: true, mode: "even", members: [claude, codex] } };
    fixture.api.mockResolvedValueOnce({ aiPool: { enabled: true, mode: "inOrder", members: [claude, codex] } });
    choose(render().mode, "inOrder");
    await flush();
    expect(sent()).toEqual({ aiPool: { enabled: true, mode: "inOrder", members: [claude, codex] } });
  });

  it("checks the levels and the floor before it saves, and saves them when they are valid", async () => {
    fixture.config = { aiPool: { enabled: true, mode: "even", members: [claude, codex] } };
    fixture.values[FOLD] = true;
    choose(render().levels, "90, 90");
    blur(render().levels);
    expect(render().html).toContain("Each level must be lower than the one before it.");
    choose(render().levels, "90, abc");
    expect(render().html).toContain("Use whole numbers from 1 to 99, like 90, 80, 70.");
    choose(render().levels, "100, 50");
    expect(render().html).toContain("Use whole numbers from 1 to 99, like 90, 80, 70.");
    choose(render().levels, "9 8 7 6 5 4 3 2 1 0");
    expect(render().html).toContain("Use whole numbers from 1 to 99");
    choose(render().levels, "99 98 97 96 95 94 93 92 91 90");
    expect(render().html).toContain("Use between 1 and 9 levels.");
    choose(render().levels, "90, 80");
    choose(render().floor, "80");
    expect(render().html).toContain("The floor must be lower than the last level.");
    choose(render().floor, "99");
    expect(render().html).toContain("The floor is a whole number from 0 to 98.");
    blur(render().floor);
    expect(fixture.api).not.toHaveBeenCalled();
    choose(render().floor, "");
    expect(render().html).not.toContain('role="alert"');
    fixture.api.mockResolvedValueOnce({ aiPool: { enabled: true, mode: "even", members: [claude, codex], levels: [90, 70, 50] } });
    choose(render().levels, "90, 70, 50");
    blur(render().levels);
    await flush();
    expect(sent(0)).toEqual({ aiPool: { enabled: true, mode: "even", members: [claude, codex], levels: [90, 70, 50] } });
    fixture.api.mockResolvedValueOnce({ aiPool: { enabled: true, mode: "even", members: [claude, codex], levels: [90, 70, 50], floor: 40 } });
    choose(render().floor, "40");
    blur(render().floor);
    await flush();
    expect(sent(1)).toEqual({ aiPool: { enabled: true, mode: "even", members: [claude, codex], levels: [90, 70, 50], floor: 40 } });
  });

  it("with no levels typed it sends none, so the usual levels apply", async () => {
    fixture.config = { aiPool: { enabled: false, mode: "even", members: [claude, codex] } };
    fixture.api.mockResolvedValueOnce({ aiPool: { enabled: true, mode: "even", members: [claude, codex] } });
    click(render().toggle);
    await flush();
    expect(sent().aiPool).not.toHaveProperty("levels");
    expect(sent().aiPool).not.toHaveProperty("floor");
  });

  it("shows a refusal from the server as it came, keeps the choice, and disables the controls while it saves", async () => {
    fixture.config = { aiPool: { enabled: false, mode: "even", members: [claude, codex] } };
    let reject!: (cause: Error) => void;
    fixture.api.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    click(render().toggle);
    expect(render().toggle.props.disabled).toBe(true);
    expect(render().button("Move Claude down").props.disabled).toBe(true);
    reject(new Error("Fixture refusal from the server."));
    await flush();
    const html = render().html;
    expect(html).toContain('role="alert"');
    expect(html).toContain("Fixture refusal from the server.");
    expect(render().toggle.props.checked).toBe(true);
    expect(render().toggle.props.disabled).toBe(false);
  });

  it("turns off at once, keeps the AIs, and shows a failed turn-off under the switch", async () => {
    fixture.config = { aiPool: { enabled: true, mode: "inOrder", members: [claude, codex], levels: [80, 40], floor: 5 } };
    fixture.api.mockResolvedValueOnce({ aiPool: { enabled: false, mode: "inOrder", members: [claude, codex], levels: [80, 40], floor: 5 } });
    click(render().toggle);
    await flush();
    expect(sent()).toEqual({ aiPool: { enabled: false, mode: "inOrder", members: [claude, codex], levels: [80, 40], floor: 5 } });
    expect(render().toggle.props.checked).toBe(false);
    fixture.config = { aiPool: { enabled: true, mode: "inOrder", members: [claude, codex] } };
    fixture.values = [];
    fixture.api.mockRejectedValueOnce(new Error("Fixture turn-off failed."));
    click(render().toggle);
    await flush();
    expect(render().html).toContain("Fixture turn-off failed.");
  });

  it("shows a saved AI that is no longer available", () => {
    fixture.config = { aiPool: { enabled: true, mode: "even", members: [claude, { instanceId: "gone", model: "old" }] } };
    const html = render().html;
    expect(html).toContain("gone");
    expect(html).toContain("old (unavailable)");
  });
});
