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

export function poolReading(limit: EngineLimit | undefined): { remaining: number | null; resetsAt: number | null } {
  if (!limit || limit.usedPercent === null) return { remaining: null, resetsAt: limit?.resetsAt ?? null };
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

export interface PoolMemberState { eligible: boolean; remaining: number | null; resetsAt: number | null }

export interface PickPoolMemberInput {
  mode: AiPoolMode;
  levels: readonly number[];
  floor: number;
  /** In pool order. */
  members: PoolMemberState[];
  currentIndex: number;
  /** Undefined before the pool first placed this conversation. */
  threadLevel?: number | undefined;
}

/** The member a conversation uses for its next turn: `index` equals `currentIndex` to stay. */
export function pickPoolMember(input: PickPoolMemberInput): { index: number; threadLevel: number } {
  const { mode, members, currentIndex, threadLevel, floor } = input;
  const current = members[currentIndex];
  if (mode === "inOrder") {
    const runs = (member: PoolMemberState | undefined) => Boolean(member?.eligible && (member.remaining === null || member.remaining > floor));
    if (threadLevel !== undefined && runs(current)) return { index: currentIndex, threadLevel: floor };
    const first = members.findIndex(runs);
    return { index: first === -1 ? currentIndex : first, threadLevel: floor };
  }
  const known = members.flatMap((member, index) => (member.eligible && member.remaining !== null ? [{ ...member, index, remaining: member.remaining }] : []));
  const level = [...input.levels, floor].filter((candidate) => known.some((member) => member.remaining > candidate)).reduce<number | undefined>((best, candidate) => (best === undefined || candidate > best ? candidate : best), undefined);
  if (level === undefined) {
    if (current?.eligible && current.remaining === null) return { index: currentIndex, threadLevel: threadLevel ?? floor };
    const unknown = members.findIndex((member) => member.eligible && member.remaining === null);
    return { index: unknown === -1 ? currentIndex : unknown, threadLevel: threadLevel ?? floor };
  }
  const held = Math.min(level, threadLevel ?? level);
  if (current?.eligible && current.remaining !== null && current.remaining > held) return { index: currentIndex, threadLevel: held };
  const pick = known.filter((member) => member.remaining > level).sort((a, b) => b.remaining - a.remaining
    || (a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity) || a.index - b.index)[0]!;
  return { index: pick.index, threadLevel: level };
}
