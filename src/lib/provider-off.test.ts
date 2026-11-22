import { describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import { moveTarget, planProviderOff, providerUses, runProviderOff, undoProviderOff } from "./provider-off";
import { providerHealth } from "./provider-health";

const instance = (instanceId: string, extra: Partial<InstanceInfo> = {}): InstanceInfo => ({
  instanceId, driverKind: "codex", displayName: instanceId.toUpperCase(), access: "subscription",
  snapshot: { state: "available", authenticated: true }, models: { default: `${instanceId}-model`, options: [{ id: `${instanceId}-model`, label: "M" }] },
  ...extra,
});
const bot = (id: string, on: string, extra: Partial<Bot> = {}): Bot => ({
  id, name: id, modelSelection: { instanceId: on, model: `${on}-model` }, ...extra,
} as Bot);
const health = (one: InstanceInfo) => providerHealth(one);

describe("providerUses", () => {
  it("counts a bot by its model and by its backup AI", () => {
    const bots = [bot("a", "x"), bot("b", "y", { fallback: [{ instanceId: "x", model: "m" }] }), bot("c", "y")];
    expect(providerUses("x", bots).map((one) => one.id)).toEqual(["a", "b"]);
  });
});

describe("moveTarget", () => {
  it("picks the first other provider that can run a task", () => {
    const list = [instance("x"), instance("down", { snapshot: { state: "available", authenticated: false } }), instance("y"), instance("z")];
    expect(moveTarget("x", list, health)?.selection).toEqual({ instanceId: "y", model: "y-model" });
  });

  it("has no target when every other provider is not ready", () => {
    const list = [instance("x"), instance("down", { snapshot: { state: "available", authenticated: false } })];
    expect(moveTarget("x", list, health)).toBeNull();
    expect(moveTarget("x", [instance("x")], health)).toBeNull();
  });
});

describe("planProviderOff", () => {
  const target = moveTarget("x", [instance("x"), instance("y")], health)!;

  it("moves the model and the backup of each bot, and skips a busy bot", () => {
    const bots = [
      bot("a", "x"),
      bot("b", "z", { fallback: [{ instanceId: "x", model: "m" }, { instanceId: "q", model: "m" }] }),
      bot("c", "x", { busy: true }),
      bot("d", "z"),
    ];
    const plan = planProviderOff("x", bots, target);
    expect(plan.uses.map((one) => one.id)).toEqual(["a", "b", "c"]);
    expect(plan.rows.map((row) => row.status)).toEqual(["apply", "apply", "skip"]);
    expect(plan.rows[0]).toMatchObject({ patch: { modelSelection: { instanceId: "y", model: "y-model" }, keepThreadModels: true } });
    expect(plan.rows[1]).toMatchObject({ patch: { fallback: [{ instanceId: "y", model: "y-model" }, { instanceId: "q", model: "m" }] } });
    expect((plan.rows[1] as { patch: object }).patch).not.toHaveProperty("modelSelection");
  });

  it("drops a backup that repeats the new model's provider", () => {
    const plan = planProviderOff("x", [bot("a", "x", { fallback: [{ instanceId: "x", model: "m" }] })], target);
    expect(plan.rows[0]).toMatchObject({ patch: { fallback: [] } });
  });

  it("plans nothing without a target", () => {
    expect(planProviderOff("x", [bot("a", "x")], null)).toMatchObject({ rows: [], target: null });
  });
});

describe("runProviderOff", () => {
  const y = instance("y");
  const x = instance("x");
  const target = moveTarget("x", [x, y], health)!;
  const actions = () => ({
    persist: vi.fn(async () => undefined), hide: vi.fn(async () => undefined), followBotModel: vi.fn(async () => undefined),
  });

  it("moves every bot, then their conversations, then hides", async () => {
    const calls = actions();
    const order: string[] = [];
    calls.persist.mockImplementation(async (one: Bot) => { order.push(`move ${one.id}`); });
    calls.followBotModel.mockImplementation(async (one: Bot) => { order.push(`follow ${one.id}`); });
    calls.hide.mockImplementation(async () => { order.push("hide"); });
    const result = await runProviderOff(x, planProviderOff("x", [bot("a", "x"), bot("b", "x")], target), calls);
    expect(order).toEqual(["move a", "move b", "follow a", "follow b", "hide"]);
    expect(result).toMatchObject({ hidden: true, target: "Y", stayed: [] });
    expect(result.moved.map((one) => one.id)).toEqual(["a", "b"]);
    expect(result.moved[0]!.modelSelection).toEqual({ instanceId: "x", model: "x-model" });
  });

  it("reports the bots it moved and the bot that stays, and does not hide", async () => {
    const calls = actions();
    const result = await runProviderOff(x, planProviderOff("x", [bot("a", "x"), bot("b", "x", { busy: true })], target), calls);
    expect(calls.hide).not.toHaveBeenCalled();
    expect(result.hidden).toBe(false);
    expect(result.moved.map((one) => one.id)).toEqual(["a"]);
    expect(result.stayed.map((one) => one.name)).toEqual(["b"]);
  });

  it("keeps a bot in place when the save is refused, and says which one", async () => {
    const calls = actions();
    calls.persist.mockRejectedValueOnce(new Error("bot is busy"));
    const result = await runProviderOff(x, planProviderOff("x", [bot("a", "x")], target), calls);
    expect(result).toMatchObject({ hidden: false, moved: [], stayed: [{ name: "a", reason: "bot is busy" }] });
  });

  it("reports the refusal when the provider cannot be hidden", async () => {
    const calls = actions();
    calls.hide.mockRejectedValueOnce(new Error("Wait for bots to finish"));
    const result = await runProviderOff(x, planProviderOff("x", [], null), calls);
    expect(result).toMatchObject({ hidden: false, error: "Wait for bots to finish" });
  });

  it("hides at once a provider no bot uses", async () => {
    const calls = actions();
    const result = await runProviderOff(x, planProviderOff("x", [bot("a", "y")], null), calls);
    expect(calls.persist).not.toHaveBeenCalled();
    expect(result).toMatchObject({ hidden: true, moved: [] });
  });
});

describe("undoProviderOff", () => {
  it("unhides the provider, then puts each bot back", async () => {
    const order: string[] = [];
    const failed = await undoProviderOff(
      { instanceId: "x", name: "X", hidden: true, stayed: [], moved: [
        { id: "a", name: "a", modelSelection: { instanceId: "x", model: "m" } },
        { id: "b", name: "b", modelSelection: { instanceId: "x", model: "m" }, fallback: [{ instanceId: "q", model: "m" }] },
      ] },
      { unhide: async () => { order.push("unhide"); }, restore: async (one) => { order.push(`restore ${one.id}`); } },
    );
    expect(order).toEqual(["unhide", "restore a", "restore b"]);
    expect(failed).toEqual([]);
  });

  it("names a bot it could not restore", async () => {
    const failed = await undoProviderOff(
      { instanceId: "x", name: "X", hidden: false, stayed: [], moved: [{ id: "a", name: "Ann", modelSelection: { instanceId: "x", model: "m" } }] },
      { unhide: async () => { throw new Error("no"); }, restore: async () => { throw new Error("no"); } },
    );
    expect(failed).toEqual(["Ann"]);
  });
});
