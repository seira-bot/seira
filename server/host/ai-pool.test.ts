import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelSelection } from "../../shared/wire.ts";
import type { AiPoolConfig } from "../ai-pool.ts";
import { createAiPool } from "./ai-pool.ts";

const on = (instanceId: string): ModelSelection => ({ instanceId, model: `${instanceId}-model` });
const NAMES: Record<string, string> = { a: "Alpha", b: "Beta", c: "Gamma" };
const NOW = 1_000_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const fileIn = () => {
  const dir = mkdtempSync(join(tmpdir(), "seira-ai-pool-"));
  dirs.push(dir);
  return join(dir, "ai-pool-threads.json");
};

interface Over {
  pool?: Partial<AiPoolConfig> | null; thread?: ModelSelection | null; bot?: ModelSelection | null;
  usage?: Record<string, number | null>; resets?: Record<string, number | null>; blocked?: string[]; paid?: string[]; moveOk?: boolean;
  file?: string; now?: () => number; maxTracked?: number;
}

function setup(over: Over = {}) {
  const pool: AiPoolConfig | undefined = over.pool === null ? undefined : { enabled: true, mode: "even", members: [on("a"), on("b"), on("c")], ...over.pool };
  const own = over.thread === undefined ? { instanceId: "a", model: "mine" } : over.thread;
  const state = { thread: own, usage: { a: 20, b: 80, c: 60, ...over.usage } as Record<string, number | null>, resets: { ...over.resets } as Record<string, number | null> };
  const moveTo = vi.fn((_bot: string, _thread: string, _from: ModelSelection, to: ModelSelection) => {
    if (over.moveOk === false) return false;
    state.thread = { instanceId: to.instanceId, model: to.model };
    return true;
  });
  const note = vi.fn();
  const make = () => createAiPool({
    ...(over.file ? { file: over.file } : {}),
    ...(over.maxTracked ? { maxTrackedThreads: over.maxTracked } : {}),
    config: () => pool,
    threadModel: () => state.thread,
    botModel: () => (over.bot === undefined ? own : over.bot),
    reading: (id) => ({ remaining: state.usage[id] ?? null, resetsAt: state.resets[id] ?? null }),
    paid: (id) => Boolean(over.paid?.includes(id)),
    canRun: (_bot, _thread, _from, to) => !over.blocked?.includes(to.instanceId),
    moveTo, note, engineName: (id) => NAMES[id] ?? id,
    now: over.now ?? (() => NOW),
  });
  return { instance: make(), make, moveTo, note, state, pool };
}

describe("AI pool placement", () => {
  it("does nothing while the pool is off or too small", () => {
    const pools: Array<Partial<AiPoolConfig> | null> = [null, { enabled: false }, { members: [on("a")] }];
    for (const pool of pools) {
      const { instance, moveTo } = setup({ pool });
      expect(instance.place("bot", "t")).toBe(false);
      expect(moveTo).not.toHaveBeenCalled();
    }
  });

  it("does nothing when the conversation has no AI or one outside the pool", () => {
    expect(setup({ thread: null }).instance.place("bot", "t")).toBe(false);
    const { instance, moveTo } = setup({ thread: on("zzz"), bot: on("zzz") });
    expect(instance.place("bot", "t")).toBe(false);
    expect(moveTo).not.toHaveBeenCalled();
  });

  it("moves once to the member with more usage left and says so", () => {
    const { instance, moveTo, note } = setup();
    expect(instance.place("bot", "t")).toBe(true);
    expect(moveTo).toHaveBeenCalledTimes(1);
    expect(moveTo).toHaveBeenCalledWith("bot", "t", { instanceId: "a", model: "mine" }, on("b"));
    expect(note).toHaveBeenCalledTimes(1);
    expect(note).toHaveBeenCalledWith("t", "Beta has more usage left, so this conversation moved from Alpha to Beta.");
  });

  it("stays when the current member is high enough", () => {
    const { instance, moveTo, note } = setup({ usage: { a: 95, b: 96, c: 96 } });
    expect(instance.place("bot", "t")).toBe(false);
    expect(moveTo).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
  });

  it("neither notes nor reports a move that did not happen", () => {
    const { instance, note } = setup({ moveOk: false });
    expect(instance.place("bot", "t")).toBe(false);
    expect(note).not.toHaveBeenCalled();
  });

  it("skips members that cannot run", () => {
    const { instance, moveTo } = setup({ blocked: ["b"] });
    instance.place("bot", "t");
    expect(moveTo).toHaveBeenCalledWith("bot", "t", expect.anything(), on("c"));
  });

  it("says why for each kind of move", () => {
    const order = setup({ pool: { mode: "inOrder" }, thread: { instanceId: "b", model: "mine" } });
    order.instance.place("bot", "t");
    expect(order.note).toHaveBeenCalledWith("t", "Alpha comes first in the AI pool, so this conversation moved from Beta to Alpha.");
    const cannot = setup({ pool: { mode: "inOrder" }, blocked: ["a"], thread: { instanceId: "a", model: "mine" } });
    cannot.instance.place("bot", "t");
    expect(cannot.note).toHaveBeenCalledWith("t", "Alpha can't take this turn, so this conversation moved to Beta.");
    const low = setup({ usage: { a: 0, b: null, c: null } });
    low.instance.place("bot", "t");
    expect(low.note).toHaveBeenCalledWith("t", "Alpha is low on usage, so this conversation moved to Beta.");
    const inOrderLow = setup({ pool: { mode: "inOrder", floor: 10 }, usage: { a: 5, b: 100, c: 100 } });
    inOrderLow.instance.place("bot", "t");
    expect(inOrderLow.note).toHaveBeenCalledWith("t", "Alpha is low on usage, so this conversation moved to Beta.");
    const payPerUse = setup({ paid: ["a"], usage: { a: null, b: 80, c: 60 } });
    payPerUse.instance.place("bot", "t");
    expect(payPerUse.note).toHaveBeenCalledWith("t", "Alpha is pay-per-use, so this conversation moved to Beta.");
  });
});

describe("AI pool records", () => {
  it("leaves a conversation alone whose model is not the bot's own and that the pool never placed", () => {
    const { instance, moveTo } = setup({ thread: { instanceId: "a", model: "picked" }, bot: { instanceId: "a", model: "mine" } });
    expect(instance.place("bot", "t")).toBe(false);
    expect(moveTo).not.toHaveBeenCalled();
  });

  it("keeps placing a conversation it moved, even though its model is not the bot's own", () => {
    const { instance, moveTo, state } = setup();
    expect(instance.place("bot", "t")).toBe(true);
    state.usage = { a: 20, b: 20, c: 60 };
    expect(instance.place("bot", "t")).toBe(true);
    expect(moveTo).toHaveBeenLastCalledWith("bot", "t", on("b"), on("c"));
  });

  it("drops a conversation that something else moved, and does not place it that turn", () => {
    const { instance, moveTo, state } = setup();
    instance.place("bot", "t");
    state.thread = on("c");
    expect(instance.place("bot", "t")).toBe(false);
    expect(moveTo).toHaveBeenCalledTimes(1);
    state.thread = { instanceId: "a", model: "mine" };
    expect(instance.place("bot", "t")).toBe(true);
  });

  it("lets a conversation's level rise once the window of the member it was written for has ended", () => {
    const clock = { at: NOW };
    const { instance, moveTo, state } = setup({ usage: { a: 55, b: 52, c: 40 }, resets: { a: NOW + 1000, b: NOW + 1000, c: NOW + 1000 }, now: () => clock.at });
    expect(instance.place("bot", "t")).toBe(false);
    state.usage = { a: 55, b: 100, c: 100 };
    expect(instance.place("bot", "t"), "the conversation keeps its level 50").toBe(false);
    clock.at = NOW + 2000;
    state.resets = { a: NOW + 9000, b: NOW + 9000, c: NOW + 9000 };
    expect(instance.place("bot", "t"), "the level may rise again").toBe(true);
    expect(moveTo).toHaveBeenCalledWith("bot", "t", expect.anything(), on("b"));
  });

  it("keeps records across a restart", () => {
    const file = fileIn();
    const first = setup({ file });
    first.instance.place("bot", "t");
    const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, { instanceId: string; model: string; level: number; until: number | null }>;
    expect(saved.t).toEqual({ instanceId: "b", model: "b-model", level: 70, until: null });
    const second = first.make();
    first.state.usage = { a: 20, b: 20, c: 60 };
    expect(second.place("bot", "t"), "the record says the pool placed it").toBe(true);
    expect(first.moveTo).toHaveBeenLastCalledWith("bot", "t", on("b"), on("c"));
  });

  it("starts empty from a missing or bad file", () => {
    const file = fileIn();
    writeFileSync(file, "{not json");
    expect(setup({ file }).instance.place("bot", "t")).toBe(true);
    expect(setup({ file: join(file, "nope", "x.json") }).instance.place("bot", "t")).toBe(true);
  });

  it("keeps at most 2000 records and drops the oldest", () => {
    const file = fileIn();
    const { instance } = setup({ file, usage: { a: 95, b: 96, c: 96 } });
    for (let i = 0; i < 2002; i++) instance.place("bot", `t${i}`);
    const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(Object.keys(saved)).toHaveLength(2000);
    expect(saved.t0).toBeUndefined();
    expect(saved.t2001).toBeDefined();
  }, 60_000);
});

describe("AI pool levels and models", () => {
  it("does not pin a conversation that was placed with no level of its own", () => {
    const { instance, moveTo, state, pool } = setup({ pool: { mode: "inOrder", floor: 10, members: [on("a"), on("b")] }, usage: { a: 100, b: 100 } });
    expect(instance.place("bot", "t")).toBe(false);
    pool!.mode = "even";
    state.usage = { a: 20, b: 100 };
    expect(instance.place("bot", "t")).toBe(true);
    expect(moveTo).toHaveBeenCalledWith("bot", "t", expect.anything(), on("b"));
  });

  it("keeps the model the person chose inside the same AI, and drops the record", () => {
    const file = fileIn();
    const { instance, moveTo, state } = setup({ file, usage: { a: 95, b: 96, c: 96 } });
    expect(instance.place("bot", "t")).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8")).t).toMatchObject({ instanceId: "a", model: "mine" });
    state.thread = { instanceId: "a", model: "sonnet" };
    state.usage = { a: 20, b: 80, c: 60 };
    expect(instance.place("bot", "t")).toBe(false);
    expect(moveTo).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(file, "utf8")).t).toBeUndefined();
  });

  it("drops a saved record that has no model", () => {
    const file = fileIn();
    writeFileSync(file, JSON.stringify({ t: { instanceId: "b", level: 70, until: null } }));
    const { instance, moveTo } = setup({ file, thread: on("b"), bot: { instanceId: "a", model: "mine" } });
    expect(instance.place("bot", "t")).toBe(false);
    expect(moveTo).not.toHaveBeenCalled();
  });

  it("does not evict a conversation that is placed again", () => {
    const file = fileIn();
    const { instance } = setup({ file, maxTracked: 3, usage: { a: 95, b: 96, c: 96 } });
    for (const id of ["t1", "t2", "t3", "t1", "t4"]) instance.place("bot", id);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8"))).sort()).toEqual(["t1", "t3", "t4"]);
  });
});

describe("AI pool backups", () => {
  it("lists the other members in order", () => {
    expect(setup().instance.backupsFor(on("b"))).toEqual([on("a"), on("c")]);
  });
  it("lists plans before pay-per-use keys", () => {
    expect(setup({ paid: ["a"] }).instance.backupsFor(on("b"))).toEqual([on("c"), on("a")]);
  });
  it("lists none when the pool is off or the AI is not a member", () => {
    expect(setup({ pool: { enabled: false } }).instance.backupsFor(on("a"))).toEqual([]);
    expect(setup().instance.backupsFor(on("zzz"))).toEqual([]);
  });
});
