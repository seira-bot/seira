import { describe, expect, it } from "vitest";

import { aiPoolSchema, pickPoolMember, poolReading, samePlanPair, type AiPoolMode, type PoolMemberState } from "./ai-pool.ts";

const NAMES = "ABCDE";
const LEVELS = [90, 80, 70, 50];

interface Run { picks: string[]; moves: number; members: PoolMemberState[]; threadLevel: number | undefined }

function simulate(options: {
  members: PoolMemberState[]; start: number; turns: number; threadLevel?: number; mode?: AiPoolMode; floor?: number;
  before?: (turn: number, members: PoolMemberState[]) => void;
}): Run {
  const members = options.members.map((member) => ({ ...member }));
  let current = options.start, threadLevel = options.threadLevel, moves = 0;
  const picks: string[] = [];
  for (let turn = 1; turn <= options.turns; turn++) {
    options.before?.(turn, members);
    const picked = pickPoolMember({ mode: options.mode ?? "even", levels: LEVELS, floor: options.floor ?? 0, members, currentIndex: current, threadLevel });
    if (picked.index !== current) moves++;
    current = picked.index;
    threadLevel = picked.threadLevel;
    picks.push(NAMES[current]!);
    const used = members[current]!;
    if (used.remaining !== null) used.remaining = Math.max(0, used.remaining - 5);
  }
  return { picks, moves, members, threadLevel };
}

const known = (remaining: number, resetsAt = 1000): PoolMemberState => ({ eligible: true, remaining, resetsAt });
const rows = (picks: string[], from: number, to: number) => picks.slice(from - 1, to).join("");

describe("pickPoolMember, even mode", () => {
  it("example 1: five equal members step down level by level", () => {
    const run = simulate({ members: [0, 1, 2, 3, 4].map(() => known(100)), start: 0, turns: 50 });
    expect(rows(run.picks, 1, 10)).toBe("AABBCCDDEE");
    expect(rows(run.picks, 11, 20)).toBe("EEAABBCCDD");
    expect(rows(run.picks, 21, 30)).toBe("DDAABBCCEE");
    expect(rows(run.picks, 31, 50)).toBe("EEEEAAAABBBBCCCCDDDD");
    expect(run.moves).toBe(16);
    expect(run.members.map((member) => member.remaining)).toEqual([50, 50, 50, 50, 50]);
  });

  it("example 2: unknown and ineligible members are not picked while known ones have usage left", () => {
    const members: PoolMemberState[] = [known(62), known(74), known(80), { eligible: true, remaining: null, resetsAt: null }, { eligible: false, remaining: 100, resetsAt: null }];
    const run = simulate({ members, start: 0, turns: 14 });
    expect(run.picks.join("")).toBe("CCBBBBBCCCCAAA");
    expect(run.moves).toBe(4);
    expect(run.members.slice(0, 3).map((member) => member.remaining)).toEqual([47, 49, 50]);
    expect(run.picks).not.toContain("D");
    expect(run.picks).not.toContain("E");
  });

  it("example 3: a conversation keeps its own level and leaves a tie for the member that resets first", () => {
    const members: PoolMemberState[] = [known(72), known(50, 3 * 3600_000), known(48), known(50, 3600_000), known(51)];
    let run = simulate({ members, start: 0, turns: 15, threadLevel: 50 });
    expect(run.picks.join("")).toBe("AAAAAEEEEEEEEEE");
    expect(run.members[4]!.remaining).toBe(1);
    const next = run.members.map((member) => ({ ...member }));
    next[4]!.eligible = false;
    run = simulate({ members: next, start: 4, turns: 1, threadLevel: run.threadLevel });
    expect(run.picks).toEqual(["D"]);
  });

  it("leaves an unknown current member as soon as a known member is above a level", () => {
    const members: PoolMemberState[] = [{ eligible: true, remaining: null, resetsAt: null }, known(95)];
    expect(pickPoolMember({ mode: "even", levels: LEVELS, floor: 0, members, currentIndex: 0 }).index).toBe(1);
  });

  it("moves to the first unknown member when every known member is at or below the floor", () => {
    const members: PoolMemberState[] = [known(50), { eligible: true, remaining: null, resetsAt: null }, { eligible: true, remaining: null, resetsAt: null }];
    expect(pickPoolMember({ mode: "even", levels: LEVELS, floor: 50, members, currentIndex: 0 })).toEqual({ index: 1, threadLevel: 50 });
  });

  it("stays when every known member is at or below the floor and nothing is unknown", () => {
    const members: PoolMemberState[] = [known(50), known(40)];
    expect(pickPoolMember({ mode: "even", levels: LEVELS, floor: 50, members, currentIndex: 1 }).index).toBe(1);
  });

  it("stays on an eligible unknown member when no known member has usage left", () => {
    const members: PoolMemberState[] = [known(0), { eligible: true, remaining: null, resetsAt: null }];
    expect(pickPoolMember({ mode: "even", levels: LEVELS, floor: 0, members, currentIndex: 1 }).index).toBe(1);
  });
});

describe("pickPoolMember, in-order mode", () => {
  const three = (): PoolMemberState[] => [known(100), known(100), known(100)];
  const pick = (members: PoolMemberState[], currentIndex: number, threadLevel?: number) =>
    pickPoolMember({ mode: "inOrder", levels: LEVELS, floor: 0, members, currentIndex, threadLevel });

  it("moves a new conversation to the first member, then stays while it runs", () => {
    const members = three();
    const first = pick(members, 1);
    expect(first.index).toBe(0);
    expect(pick(members, 0, first.threadLevel).index).toBe(0);
  });

  it("moves to the next member when the first cannot run, and stays there when the first returns", () => {
    const members = three();
    members[0]!.eligible = false;
    const moved = pick(members, 0, 0);
    expect(moved.index).toBe(1);
    members[0]!.eligible = true;
    expect(pick(members, 1, moved.threadLevel).index).toBe(1);
    expect(pick(members, 1).index).toBe(0);
  });

  it("treats a member at the floor as unable to run", () => {
    const members: PoolMemberState[] = [known(0), known(40)];
    expect(pick(members, 0, 0).index).toBe(1);
  });
});

describe("poolReading", () => {
  it("reads usage left from the fullest window", () => {
    expect(poolReading({ usedPercent: 30, resetsAt: 5 } as never)).toEqual({ remaining: 70, resetsAt: 5 });
    expect(poolReading({ usedPercent: 130, resetsAt: null } as never).remaining).toBe(0);
    expect(poolReading({ usedPercent: null, resetsAt: null } as never).remaining).toBeNull();
    expect(poolReading(undefined)).toEqual({ remaining: null, resetsAt: null });
  });
});

describe("aiPoolSchema", () => {
  const member = (instanceId: string) => ({ instanceId, model: "m" });
  const message = (value: unknown) => {
    const parsed = aiPoolSchema.safeParse(value);
    return parsed.success ? null : parsed.error.issues[0]!.message;
  };

  it("accepts a valid pool and fills defaults", () => {
    const parsed = aiPoolSchema.parse({ enabled: true, members: [member("a"), member("b")] });
    expect(parsed.mode).toBe("even");
  });
  it("refuses fewer than two members when on", () => {
    expect(message({ enabled: true, members: [member("a")] })).toBe("Choose at least two AIs before you turn on the AI pool.");
    expect(message({ enabled: false, members: [member("a")] })).toBeNull();
  });
  it("refuses the same AI twice", () => {
    expect(message({ enabled: true, members: [member("a"), member("a")] })).toBe("Each AI can join the pool once.");
  });
  it("refuses levels that do not fall", () => {
    expect(message({ enabled: true, members: [member("a"), member("b")], levels: [50, 60] })).toBe("Each level must be lower than the one before it.");
    expect(message({ enabled: true, members: [member("a"), member("b")], levels: [50, 50] })).toBe("Each level must be lower than the one before it.");
  });
  it("refuses a floor that is not below the last level", () => {
    expect(message({ enabled: true, members: [member("a"), member("b")], levels: [80, 50], floor: 50 })).toBe("The floor must be lower than the last level.");
    expect(message({ enabled: true, members: [member("a"), member("b")], levels: [80, 50], floor: 49 })).toBeNull();
  });
});

describe("samePlanPair", () => {
  const plan = (instanceId: string, driverKind = "claudeAgent", billsEachUse = false) => ({ instanceId, driverKind, billsEachUse });
  it("finds two plan sign-ins of one subscription", () => {
    expect(samePlanPair([plan("a"), plan("x", "codex"), plan("b")])).toEqual([0, 2]);
  });
  it("allows a second sign-in that bills each use", () => {
    expect(samePlanPair([plan("a"), plan("b", "claudeAgent", true)])).toBeNull();
  });
  it("allows different AIs", () => {
    expect(samePlanPair([plan("a"), plan("b", "codex")])).toBeNull();
  });
});
