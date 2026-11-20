import { z } from "zod";

import { otherSignInOfSameSubscription } from "../shared/limit-backup.ts";
import type { EngineLimit } from "../shared/limit-reset.ts";
import { defaultModelSelectionSchema } from "./model-selection-schema.ts";

export type AiPoolMode = "even" | "inOrder";

/** Default levels, as the share of usage left, from which the pool moves a conversation on. */
export const AI_POOL_LEVELS = [90, 80, 70, 60, 50, 40, 30, 20, 10];

export const aiPoolSchema = z.object({
  enabled: z.boolean(),
  /** `even` shares usage by levels of usage left. `inOrder` uses the first AI until it cannot run, then the next. */
  mode: z.enum(["even", "inOrder"]).default("even"),
  /** The AIs that share usage, in order. Two to ten, each at most once. */
  members: z.array(defaultModelSelectionSchema).max(10).default([]),
  /** Usage left, in percent, that `even` mode steps down through. */
  levels: z.array(z.number().int().min(1).max(99)).min(1).max(9).optional(),
  /** Usage left, in percent, at which an AI stops taking new work from the pool. */
  floor: z.number().int().min(0).max(98).optional(),
}).strict().superRefine((pool, ctx) => {
  const issue = (message: string, path: (string | number)[]) => ctx.addIssue({ code: "custom", message, path });
  if (pool.enabled && pool.members.length < 2) issue("Choose at least two AIs before you turn on the AI pool.", ["members"]);
  if (new Set(pool.members.map((member) => member.instanceId)).size !== pool.members.length) issue("Each AI can join the pool once.", ["members"]);
  const levels = pool.levels;
  if (levels?.some((level, index) => index > 0 && level >= levels[index - 1]!)) issue("Each level must be lower than the one before it.", ["levels"]);
  if (pool.floor !== undefined && pool.floor >= (levels ?? AI_POOL_LEVELS).at(-1)!) issue("The floor must be lower than the last level.", ["floor"]);
});
export type AiPoolConfig = z.output<typeof aiPoolSchema>;

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

export type PoolReason = "stay" | "moreLeft" | "cannotRun" | "low" | "order" | "payPerUse";

export interface PickPoolMemberInput {
  mode: AiPoolMode;
  levels: readonly number[];
  floor: number;
  members: PoolMemberState[];
  currentIndex: number;
  threadLevel?: number | undefined;
}

export function pickPoolMember(input: PickPoolMemberInput): { index: number; threadLevel: number; reason: PoolReason } {
  const { mode, members, currentIndex, threadLevel, floor } = input;
  const noLevel = input.levels[0]!;
  const current = members[currentIndex];
  const move = (index: number, level: number, why: PoolReason) => ({ index, threadLevel: level, reason: index === currentIndex ? "stay" as const : current?.eligible ? why : "cannotRun" as const });
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
