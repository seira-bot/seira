import { describe, expect, it, vi } from "vitest";

import type { ModelSelection } from "../../shared/wire.ts";
import type { AiPoolConfig } from "../ai-pool.ts";
import { createAiPool } from "./ai-pool.ts";

const on = (instanceId: string): ModelSelection => ({ instanceId, model: `${instanceId}-model` });
const NAMES: Record<string, string> = { a: "Alpha", b: "Beta", c: "Gamma" };

function setup(over: { pool?: Partial<AiPoolConfig> | null; thread?: ModelSelection | null; usage?: Record<string, number | null>; blocked?: string[]; moveOk?: boolean } = {}) {
  const pool: AiPoolConfig | undefined = over.pool === null ? undefined : { enabled: true, mode: "even", members: [on("a"), on("b"), on("c")], ...over.pool };
  const moveTo = vi.fn(() => over.moveOk ?? true), note = vi.fn();
  const usage = { a: 20, b: 80, c: 60, ...over.usage };
  const instance = createAiPool({
    config: () => pool,
    threadModel: () => (over.thread === undefined ? { instanceId: "a", model: "mine" } : over.thread),
    reading: (id) => ({ remaining: usage[id as "a"] ?? null, resetsAt: null }),
    canRun: (_bot, _thread, _from, to) => !over.blocked?.includes(to.instanceId),
    moveTo, note, engineName: (id) => NAMES[id] ?? id,
  });
  return { instance, moveTo, note };
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
    const { instance, moveTo } = setup({ thread: on("zzz") });
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

  it("uses the in-order line in in-order mode", () => {
    const { instance, note } = setup({ pool: { mode: "inOrder" }, thread: { instanceId: "b", model: "mine" } });
    expect(instance.place("bot", "t")).toBe(true);
    expect(note).toHaveBeenCalledWith("t", "The AI pool uses Alpha next, so this conversation moved from Beta to Alpha.");
  });
});

describe("AI pool backups", () => {
  it("lists the other members in order", () => {
    expect(setup().instance.backupsFor(on("b"))).toEqual([on("a"), on("c")]);
  });
  it("lists none when the pool is off or the AI is not a member", () => {
    expect(setup({ pool: { enabled: false } }).instance.backupsFor(on("a"))).toEqual([]);
    expect(setup().instance.backupsFor(on("zzz"))).toEqual([]);
  });
});
