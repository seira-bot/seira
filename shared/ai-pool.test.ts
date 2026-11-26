import { describe, expect, it } from "vitest";

import { AI_POOL_MODES, AI_POOL_RESERVES, AI_POOL_STEPS, pickPoolMember, type PoolMemberState } from "./ai-pool.ts";

const LEVELS = AI_POOL_STEPS["10"];
const member = (remaining: number | null = 80, over: Partial<PoolMemberState> = {}): PoolMemberState => ({ eligible: true, remaining, resetsAt: null, paid: false, ...over });
const turns = (members: PoolMemberState[], currentIndex: number, extra: { fresh?: boolean; cursor?: number; floor?: number } = {}) =>
  pickPoolMember({ mode: "turns", levels: LEVELS, floor: extra.floor ?? 0, members, currentIndex, fresh: extra.fresh, cursor: extra.cursor });

describe("pool constants", () => {
  it("lists the modes, steps and reserves", () => {
    expect(AI_POOL_MODES).toEqual(["even", "turns", "inOrder"]);
    expect(AI_POOL_STEPS["20"]).toEqual([80, 60, 40, 20]);
    expect(AI_POOL_STEPS["25"]).toEqual([75, 50, 25]);
    expect(AI_POOL_RESERVES).toEqual([0, 10, 20, 30]);
  });
});

describe("pickPoolMember, turns mode", () => {
  const three = () => [member(), member(), member()];

  it("rotates three fresh conversations a, b, c with the cursor", () => {
    let cursor: number | undefined;
    const taken: number[] = [];
    for (let i = 0; i < 4; i++) {
      const picked = turns(three(), 0, { fresh: true, cursor });
      expect(picked.took).toBe(true);
      cursor = picked.index;
      taken.push(picked.index);
    }
    expect(taken).toEqual([0, 1, 2, 0]);
  });

  it("reports turn when a fresh conversation moves off a usable AI", () => {
    expect(turns(three(), 0, { fresh: true, cursor: 0 })).toMatchObject({ index: 1, reason: "turn", took: true });
  });

  it("reports stay when the next AI is the current one", () => {
    expect(turns(three(), 1, { fresh: true, cursor: 0 })).toMatchObject({ index: 1, reason: "stay", took: true });
  });

  it("keeps an old conversation on a usable AI", () => {
    expect(turns(three(), 2, { cursor: 0 })).toEqual({ index: 2, threadLevel: 90, reason: "stay" });
  });

  it("moves an old conversation off an AI at or below the reserve", () => {
    const members = [member(), member(10), member()];
    expect(turns(members, 1, { cursor: 0, floor: 10 })).toMatchObject({ index: 2, reason: "low", took: true });
    expect(turns(members, 1, { cursor: 0, floor: 5 })).toMatchObject({ index: 1, reason: "stay" });
  });

  it("moves an old conversation off an AI that cannot run", () => {
    const members = [member(), member(80, { eligible: false }), member()];
    expect(turns(members, 1, { cursor: 0 })).toMatchObject({ index: 2, reason: "cannotRun", took: true });
  });

  it("uses a pay-per-use AI only when no plan AI is usable", () => {
    const paid = member(null, { paid: true });
    expect(turns([paid, member(), member()], 0, { fresh: true, cursor: -1 }).index).toBe(1);
    expect(turns([paid, member(5), member(80, { eligible: false })], 1, { cursor: 0, floor: 10 })).toMatchObject({ index: 0, reason: "low" });
    expect(turns([member(5), paid], 0, { cursor: -1, floor: 10 })).toMatchObject({ index: 1 });
  });

  it("reports payPerUse when a paid AI at the reserve hands over to a plan AI", () => {
    const members = [member(5, { paid: true }), member(), member()];
    expect(turns(members, 0, { cursor: 0, floor: 10 })).toMatchObject({ index: 1, reason: "payPerUse", took: true });
  });

  it("stays when nothing is usable", () => {
    const members = [member(0), member(5, { eligible: false }), member(0)];
    expect(turns(members, 2, { fresh: true, cursor: 0 })).toEqual({ index: 2, threadLevel: 90, reason: "stay" });
  });

  it("works with no current AI", () => {
    expect(turns(three(), -1, { fresh: true, cursor: 1 })).toMatchObject({ index: 2, reason: "cannotRun", took: true });
    expect(turns(three(), -1)).toMatchObject({ index: 0, took: true });
    expect(turns([member(0), member(0)], -1)).toMatchObject({ index: -1, reason: "stay" });
  });
});

describe("pickPoolMember, other modes with no current AI", () => {
  it("does not crash", () => {
    for (const mode of ["even", "inOrder"] as const) {
      const picked = pickPoolMember({ mode, levels: LEVELS, floor: 0, members: [member(), member(50)], currentIndex: -1 });
      expect(picked.index).toBeGreaterThanOrEqual(0);
      expect(picked.reason).toBe("cannotRun");
    }
  });
});
