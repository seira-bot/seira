import { describe, expect, it } from "vitest";
import type { InstanceInfo } from "@/state/store";
import type { EngineLimit } from "@/lib/limit-resets";
import {
  activePool, levelsFor, memberStatus, nextPoolMember, planConflict, poolPick, poolReady, poolRuns, stepsOf, suggestPaidMembers, suggestPoolMembers, isPaidMember, memberBilling, type AiPool,
} from "./ai-pool";

const NOW = 1_000_000;
const engine = (id: string, driverKind: string, extra: Partial<InstanceInfo> = {}): InstanceInfo => ({
  instanceId: id, driverKind, displayName: id, access: "subscription",
  snapshot: { state: "available", authenticated: true },
  models: { default: `${id}-m`, options: [{ id: `${id}-m`, label: id }] },
  ...extra,
});
const limit = (id: string, usedPercent: number | null, extra: Partial<EngineLimit> = {}): EngineLimit => ({
  engine: id, name: id, driver: "codex", window: null, usedPercent, resetsAt: null, blocked: false, ...extra,
} as EngineLimit);
const pool = (extra: Partial<AiPool> = {}): AiPool => ({ enabled: true, mode: "even", members: [{ instanceId: "a", model: "a-m" }, { instanceId: "b", model: "b-m" }], ...extra });

describe("activePool", () => {
  it("needs the pool on and two AIs", () => {
    expect(activePool(undefined)).toBeUndefined();
    expect(activePool({ aiPool: pool({ enabled: false }) })).toBeUndefined();
    expect(activePool({ aiPool: pool({ members: [{ instanceId: "a", model: "m" }] }) })).toBeUndefined();
    expect(activePool({ aiPool: pool() })?.members).toHaveLength(2);
  });
});

describe("poolReady", () => {
  it("rejects signed-out, unavailable, blocked-by-policy and model-less AIs", () => {
    expect(poolReady(engine("a", "codex"))).toBe(true);
    expect(poolReady(engine("a", "codex", { snapshot: { state: "available", authenticated: false } }))).toBe(false);
    expect(poolReady(engine("a", "codex", { snapshot: { state: "unavailable" } }))).toBe(false);
    expect(poolReady(engine("a", "codex", { models: { default: "x", options: [{ id: "x", label: "x", orgBlocked: true }] } }))).toBe(false);
  });
});

describe("planConflict", () => {
  const claudeA = engine("claudeA", "claudeAgent");
  const claudeB = engine("claudeB", "claudeAgent");
  const codex = engine("codex", "codex");
  it("finds the member that holds the same provider plan", () => {
    expect(planConflict(claudeB, [{ instanceId: "claudeA", model: "m" }], [claudeA, claudeB])?.instanceId).toBe("claudeA");
    expect(planConflict(codex, [{ instanceId: "claudeA", model: "m" }], [claudeA, codex])).toBeUndefined();
  });
  it("lets a pay-per-use key join beside a plan", () => {
    const key = engine("claudeKey", "claudeAgent", { access: "api" });
    expect(planConflict(key, [{ instanceId: "claudeA", model: "m" }], [claudeA, key])).toBeUndefined();
  });
});

describe("suggestPoolMembers", () => {
  it("keeps one sign-in per plan, the one with more usage left, and leaves pay-per-use AIs out", () => {
    const claudeA = engine("claudeA", "claudeAgent");
    const claudeB = engine("claudeB", "claudeAgent");
    const codex = engine("codex", "codex");
    const key = engine("key", "grokAgent", { access: "api" });
    const picked = suggestPoolMembers([key, claudeA, claudeB, codex], [limit("claudeA", 80), limit("claudeB", 20), limit("codex", 50)], NOW);
    expect(picked.map((m) => m.instanceId)).toEqual(["claudeB", "codex"]);
    expect(picked[0]!.model).toBe("claudeB-m");
  });
  it("treats unknown usage as the lowest and skips signed-out AIs", () => {
    const a = engine("a", "codex");
    const b = engine("b", "claudeAgent");
    const c = engine("c", "grokAgent", { snapshot: { state: "available", authenticated: false } });
    expect(suggestPoolMembers([a, b, c], [limit("b", 10)], NOW).map((m) => m.instanceId)).toEqual(["b", "a"]);
  });
  it("gives fewer than two when there is one usable AI", () => {
    expect(suggestPoolMembers([engine("a", "codex")], [], NOW)).toHaveLength(1);
  });
});

describe("suggestPaidMembers", () => {
  const key = engine("key", "grokAgent", { access: "api" });
  const metered = engine("metered", "codex", { snapshot: { state: "available", authenticated: true, billing: "metered" } as InstanceInfo["snapshot"] });
  it("lists ready pay-per-use AIs that are not in the list yet", () => {
    const signedOut = engine("out", "grokAgent", { access: "api", snapshot: { state: "available", authenticated: false } });
    const plan = engine("plan", "codex");
    expect(suggestPaidMembers([plan, key, metered, signedOut], [{ instanceId: "plan", model: "plan-m" }]).map((m) => m.instanceId)).toEqual(["key", "metered"]);
    expect(suggestPaidMembers([plan, key], [{ instanceId: "key", model: "key-m" }])).toEqual([]);
  });
  it("does not go over the size of the pool", () => {
    const members = Array.from({ length: 9 }, (_, index) => ({ instanceId: `m${index}`, model: "m" }));
    expect(suggestPaidMembers([key, metered], members).map((m) => m.instanceId)).toEqual(["key"]);
  });
  it("knows which members bill each use", () => {
    expect(isPaidMember({ instanceId: "key", model: "m" }, [key])).toBe(true);
    expect(isPaidMember({ instanceId: "a", model: "m" }, [engine("a", "codex")])).toBe(false);
    expect(isPaidMember({ instanceId: "gone", model: "m" }, [])).toBe(false);
  });
  it("calls an AI a plan only when it says so, and never guesses from silence", () => {
    const member = (instanceId: string) => ({ instanceId, model: "m" });
    const silent = engine("silent", "codex", { access: undefined });
    const custom = engine("custom", "codex", { access: "custom" });
    const planBySnapshot = engine("snap", "codex", { access: undefined, snapshot: { state: "available", authenticated: true, billing: "subscription" } as InstanceInfo["snapshot"] });
    const instances = [key, engine("plan", "codex"), silent, custom, planBySnapshot];
    expect(["key", "plan", "silent", "custom", "snap", "gone"].map((id) => memberBilling(member(id), instances)))
      .toEqual(["paid", "plan", "unknown", "unknown", "plan", "unknown"]);
    expect(memberBilling(member("both"), [engine("both", "codex", { access: "api", snapshot: { state: "available", authenticated: true, billing: "subscription" } as InstanceInfo["snapshot"] })])).toBe("paid");
  });
});

describe("memberStatus", () => {
  const a = engine("a", "codex");
  it("reads ready, low, out, unknown, signed out and paid", () => {
    expect(memberStatus(a, limit("a", 40), 0, NOW)).toEqual({ state: "ready", left: 60, resetsAt: null });
    expect(memberStatus(a, limit("a", 85), 20, NOW).state).toBe("low");
    expect(memberStatus(a, limit("a", 100), 0, NOW).state).toBe("out");
    expect(memberStatus(a, limit("a", 10, { blocked: true, resetsAt: NOW + 5 }), 0, NOW)).toEqual({ state: "out", left: 0, resetsAt: NOW + 5 });
    expect(memberStatus(a, undefined, 0, NOW).state).toBe("unknown");
    expect(memberStatus(engine("a", "codex", { snapshot: { state: "available", authenticated: false } }), undefined, 0, NOW).state).toBe("signedOut");
    expect(memberStatus(engine("a", "codex", { access: "api" }), undefined, 0, NOW).state).toBe("paid");
    expect(memberStatus(undefined, undefined, 0, NOW).state).toBe("out");
  });
});

describe("nextPoolMember and poolPick", () => {
  const instances = [engine("a", "codex"), engine("b", "claudeAgent")];
  it("balances toward the AI with more left", () => {
    expect(nextPoolMember(pool(), instances, [limit("a", 70), limit("b", 20)], NOW)).toBe(1);
  });
  it("has no next AI in turns mode", () => {
    expect(nextPoolMember(pool({ mode: "turns" }), instances, [], NOW)).toBeUndefined();
  });
  it("keeps the current AI while it can run, else picks another", () => {
    const current = { instanceId: "a", model: "a-m" };
    expect(poolPick(pool(), instances, [limit("a", 10), limit("b", 10)], current, NOW)).toEqual(current);
    expect(poolPick(pool(), instances, [limit("a", 100), limit("b", 10)], current, NOW)).toEqual({ instanceId: "b", model: "b-m" });
  });
  it("in turns mode leaves a pay-per-use key for last", () => {
    const withKey = [engine("k", "grokAgent", { access: "api" }), engine("b", "claudeAgent")];
    const p = pool({ mode: "turns", members: [{ instanceId: "k", model: "k-m" }, { instanceId: "b", model: "b-m" }] });
    expect(poolPick(p, withKey, [limit("b", 100, { blocked: true })], { instanceId: "x", model: "m" }, NOW)?.instanceId).toBe("k");
    expect(poolPick(p, withKey, [], { instanceId: "x", model: "m" }, NOW)?.instanceId).toBe("b");
  });
});

describe("poolRuns", () => {
  const sel = { instanceId: "a", model: "a-m" };
  it("is true for an auto mark on a member, or no mark on a bot that follows a member", () => {
    expect(poolRuns(pool(), { modelSelection: sel, aiPool: "auto" }, undefined)).toBe(true);
    expect(poolRuns(pool(), { modelSelection: { instanceId: "z", model: "m" }, aiPool: "auto" }, undefined)).toBe(false);
    expect(poolRuns(pool(), { modelSelection: sel, aiPool: "pinned", followsBotModel: true }, sel)).toBe(false);
    expect(poolRuns(pool(), { modelSelection: sel, followsBotModel: true }, sel)).toBe(true);
    expect(poolRuns(pool(), { modelSelection: sel }, sel)).toBe(false);
    expect(poolRuns(undefined, { modelSelection: sel, aiPool: "auto" }, sel)).toBe(false);
  });
});

describe("steps and levels", () => {
  it("round-trips a step choice with a reserve", () => {
    expect(levelsFor("10", 0)).toBeUndefined();
    expect(levelsFor("20", 0)).toEqual([80, 60, 40, 20]);
    expect(levelsFor("20", 20)).toEqual([80, 60, 40]);
    expect(levelsFor("10", 20)).toEqual([90, 80, 70, 60, 50, 40, 30]);
    expect(stepsOf(undefined)).toBe("10");
    expect(stepsOf([80, 60, 40, 20])).toBe("20");
    expect(stepsOf([80, 60, 40], 20)).toBe("20");
    expect(stepsOf([75, 50, 25])).toBe("25");
    expect(stepsOf([77, 33])).toBe("custom");
  });
});
