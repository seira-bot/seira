import type { EngineLimit } from "./limit-reset.ts";
import { otherSignInOfSameSubscription } from "./limit-backup.ts";

export type AiPoolMode = "even" | "turns" | "inOrder";
export const AI_POOL_MODES = ["even", "turns", "inOrder"] as const satisfies readonly AiPoolMode[];

/** Default levels, as the share of usage left, from which the pool moves a conversation on. */
export const AI_POOL_LEVELS = [90, 80, 70, 60, 50, 40, 30, 20, 10];

/** The level lists that Settings offers, keyed by the gap in percent between two levels. */
export const AI_POOL_STEPS: Record<"10" | "20" | "25", number[]> = {
  "10": [90, 80, 70, 60, 50, 40, 30, 20, 10],
  "20": [80, 60, 40, 20],
  "25": [75, 50, 25],
};

/** The reserves that Settings offers: usage left, in percent, at which an AI stops taking new work. */
export const AI_POOL_RESERVES: readonly number[] = [0, 10, 20, 30];

export function poolReading(limit: EngineLimit | undefined, now: number): { remaining: number | null; resetsAt: number | null } {
  if (!limit || limit.usedPercent === null) return { remaining: null, resetsAt: limit?.resetsAt ?? null };
  if (limit.resetsAt !== null && limit.resetsAt <= now) return { remaining: null, resetsAt: limit.resetsAt };
  return { remaining: Math.min(100, Math.max(0, 100 - limit.usedPercent)), resetsAt: limit.resetsAt };
}

export function samePlanPair(members: { instanceId: string; driverKind: string; billsEachUse: boolean }[]): [number, number] | null {
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      if (otherSignInOfSameSubscription(members[i]!, members[j]!) && !members[i]!.billsEachUse && !members[j]!.billsEachUse) return [i, j];
    }
  }
  return null;
}

export interface PoolMemberState { eligible: boolean; remaining: number | null; resetsAt: number | null; paid: boolean }

export type PoolReason = "stay" | "moreLeft" | "cannotRun" | "low" | "order" | "payPerUse" | "turn";

export interface PickPoolMemberInput {
  mode: AiPoolMode;
  levels: readonly number[];
  floor: number;
  members: PoolMemberState[];
  currentIndex: number;
  threadLevel?: number | undefined;
  /** The conversation has no pool record yet. */
  fresh?: boolean | undefined;
  /** Index of the member that last took a conversation. -1 or undefined: none. */
  cursor?: number | undefined;
}

export function pickPoolMember(input: PickPoolMemberInput): { index: number; threadLevel: number; reason: PoolReason; took?: true } {
  const { mode, members, currentIndex, threadLevel, floor } = input;
  const noLevel = input.levels[0]!;
  const current = members[currentIndex];
  const move = (index: number, level: number, why: PoolReason) => ({ index, threadLevel: level, reason: index === currentIndex ? "stay" as const : current?.eligible ? why : "cannotRun" as const });
  if (mode === "turns") {
    const usable = (member: PoolMemberState | undefined) => Boolean(member?.eligible && (member.remaining === null || member.remaining > floor));
    if (!input.fresh && usable(current)) return { index: currentIndex, threadLevel: noLevel, reason: "stay" };
    const start = (input.cursor ?? -1) + 1;
    const order = members.map((_, step) => (start + step) % members.length);
    const pick = order.find((index) => usable(members[index]) && !members[index]!.paid) ?? order.find((index) => usable(members[index]));
    if (pick === undefined) return { index: currentIndex, threadLevel: noLevel, reason: "stay" };
    const reason: PoolReason = pick === currentIndex ? "stay"
      : input.fresh && usable(current) ? "turn"
      : !current?.eligible ? "cannotRun"
      : current.paid && !members[pick]!.paid ? "payPerUse" : "low";
    return { index: pick, threadLevel: noLevel, reason, took: true };
  }
  if (mode === "inOrder") {
    const first = members.findIndex((member) => member.eligible && (member.remaining === null || member.remaining > floor));
    const atFloor = current?.eligible && current.remaining !== null && current.remaining <= floor;
    return move(first === -1 ? currentIndex : first, noLevel, atFloor && first > currentIndex ? "low" : "order");
  }
  const known = members.flatMap((member, index) => (member.eligible && member.remaining !== null ? [{ ...member, index, remaining: member.remaining }] : []));
  const level = [...input.levels, floor].filter((candidate) => known.some((member) => member.remaining > candidate)).reduce<number | undefined>((best, candidate) => (best === undefined || candidate > best ? candidate : best), undefined);
  const unknown = members.flatMap((member, index) => (member.eligible && member.remaining === null ? [{ index, paid: member.paid }] : []));
  const unknownPick = () => (unknown.find((member) => !member.paid) ?? unknown.find((member) => member.paid))?.index ?? currentIndex;
  const currentUnknown = current?.eligible && current.remaining === null;
  const moveEven = (index: number, level: number, why: PoolReason) => move(index, level, current?.paid && !members[index]?.paid ? "payPerUse" : why);
  if (currentUnknown && !current.paid) return move(currentIndex, threadLevel ?? level ?? noLevel, "low");
  if (level === undefined) {
    const free = unknown.find((member) => !member.paid)?.index;
    return moveEven(currentUnknown ? free ?? currentIndex : unknownPick(), threadLevel ?? noLevel, "low");
  }
  const held = Math.min(level, threadLevel ?? level);
  if (current?.eligible && current.remaining !== null && current.remaining > held) return move(currentIndex, held, "moreLeft");
  const pick = known.filter((member) => member.remaining > level).sort((a, b) => b.remaining - a.remaining
    || (a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity) || a.index - b.index)[0]!;
  return moveEven(pick.index, level, "moreLeft");
}
