import type { ConfigStatus, InstanceInfo, ModelSelection } from "@/state/store";
import type { EngineLimit } from "@/lib/limit-resets";
import { AI_POOL_LEVELS, AI_POOL_STEPS, pickPoolMember, poolReading, type AiPoolMode } from "../../shared/ai-pool";
import { otherSignInOfSameSubscription } from "../../shared/limit-backup";

export type AiPool = NonNullable<ConfigStatus["aiPool"]>;
export type PoolStatusState = "ready" | "low" | "out" | "signedOut" | "paid" | "unknown";
export interface PoolStatus { state: PoolStatusState; left: number | null; resetsAt: number | null }
export type PoolSteps = "10" | "20" | "25" | "custom";

export const MAX_POOL_MEMBERS = 10;

export function activePool(config: Pick<ConfigStatus, "aiPool"> | null | undefined): AiPool | undefined {
  const pool = config?.aiPool;
  return pool?.enabled && pool.members.length >= 2 ? pool : undefined;
}

export const billsEachUse = (instance: InstanceInfo): boolean => instance.access === "api" || instance.snapshot.billing === "metered";

export function usableModels(instance: InstanceInfo): InstanceInfo["models"]["options"] {
  return instance.models.options.filter((model) => !model.orgBlocked && !model.needsCliUpdate);
}

export const isSignedOut = (instance: InstanceInfo): boolean => instance.snapshot.authenticated === false;

export function poolReady(instance: InstanceInfo): boolean {
  return instance.snapshot.state === "available" && !instance.policy && !isSignedOut(instance) && usableModels(instance).length > 0;
}

export function planConflict(instance: InstanceInfo, members: readonly ModelSelection[], instances: readonly InstanceInfo[]): InstanceInfo | undefined {
  if (billsEachUse(instance)) return undefined;
  for (const member of members) {
    const other = instances.find((candidate) => candidate.instanceId === member.instanceId);
    if (other && !billsEachUse(other) && otherSignInOfSameSubscription(other, instance)) return other;
  }
  return undefined;
}

const limitOf = (limits: readonly EngineLimit[], instanceId: string) => limits.find((limit) => limit.engine === instanceId);

function leftOf(instance: InstanceInfo, limits: readonly EngineLimit[], now: number): number | null {
  const limit = limitOf(limits, instance.instanceId);
  if (limit?.blocked && (limit.resetsAt === null || limit.resetsAt > now)) return 0;
  return poolReading(limit, now).remaining;
}

function defaultModel(instance: InstanceInfo): string | undefined {
  const usable = usableModels(instance);
  return usable.find((model) => model.id === instance.models.default)?.id ?? usable[0]?.id;
}

export function suggestPoolMembers(instances: readonly InstanceInfo[], limits: readonly EngineLimit[], now = Date.now()): ModelSelection[] {
  const ready = instances.filter(poolReady);
  const plans = ready.map((instance, order) => ({ instance, order, left: billsEachUse(instance) ? undefined : leftOf(instance, limits, now) }))
    .filter((entry) => entry.left !== undefined);
  plans.sort((a, b) => (b.left ?? -1) - (a.left ?? -1)
    || Number(b.instance.claudeAccount?.isDefault === true) - Number(a.instance.claudeAccount?.isDefault === true) || a.order - b.order);
  const kept: InstanceInfo[] = [];
  for (const { instance } of plans) {
    if (!kept.some((other) => otherSignInOfSameSubscription(other, instance))) kept.push(instance);
  }
  return kept.slice(0, MAX_POOL_MEMBERS).flatMap((instance) => {
    const model = defaultModel(instance);
    return model ? [{ instanceId: instance.instanceId, model }] : [];
  });
}

/** Pay-per-use AIs that are ready and not yet in the list. The owner must opt in to each use of this list. */
export function suggestPaidMembers(instances: readonly InstanceInfo[], members: readonly ModelSelection[]): ModelSelection[] {
  const taken = new Set(members.map((member) => member.instanceId));
  return instances.filter((instance) => poolReady(instance) && billsEachUse(instance) && !taken.has(instance.instanceId))
    .slice(0, Math.max(0, MAX_POOL_MEMBERS - members.length))
    .flatMap((instance) => {
      const model = defaultModel(instance);
      return model ? [{ instanceId: instance.instanceId, model }] : [];
    });
}

export type MemberBilling = "plan" | "paid" | "unknown";

/** How a member bills, from the AI as it is now. "unknown" when the AI is gone or says nothing about its billing:
 * only an AI that reports a subscription is a plan, so an AI that may cost money is never taken for one. */
export function memberBilling(member: ModelSelection, instances: readonly InstanceInfo[]): MemberBilling {
  const instance = instances.find((candidate) => candidate.instanceId === member.instanceId);
  if (!instance) return "unknown";
  if (billsEachUse(instance)) return "paid";
  return instance.access === "subscription" || instance.snapshot.billing === "subscription" ? "plan" : "unknown";
}

export const isPaidMember = (member: ModelSelection, instances: readonly InstanceInfo[]): boolean => memberBilling(member, instances) === "paid";

export function memberStatus(instance: InstanceInfo | undefined, limit: EngineLimit | undefined, reserve: number, now: number): PoolStatus {
  if (!instance || instance.snapshot.state !== "available" || instance.policy) return { state: "out", left: null, resetsAt: null };
  if (isSignedOut(instance)) return { state: "signedOut", left: null, resetsAt: null };
  if (billsEachUse(instance)) return { state: "paid", left: null, resetsAt: null };
  const reading = poolReading(limit, now);
  if (limit?.blocked && (limit.resetsAt === null || limit.resetsAt > now)) return { state: "out", left: 0, resetsAt: limit.resetsAt };
  if (reading.remaining === null) return { state: "unknown", left: null, resetsAt: reading.resetsAt };
  const state = reading.remaining <= 0 ? "out" : reading.remaining <= reserve ? "low" : "ready";
  return { state, left: Math.round(reading.remaining), resetsAt: reading.resetsAt };
}

export function nextPoolMember(pool: AiPool, instances: readonly InstanceInfo[], limits: readonly EngineLimit[], now: number): number | undefined {
  if (pool.mode === "turns") return undefined;
  const members = pool.members.map((member) => {
    const instance = instances.find((candidate) => candidate.instanceId === member.instanceId);
    const reading = poolReading(limitOf(limits, member.instanceId), now);
    const blocked = instance ? leftOf(instance, limits, now) === 0 : false;
    return { eligible: Boolean(instance && poolReady(instance)) && !blocked, paid: Boolean(instance && billsEachUse(instance)), ...reading };
  });
  const picked = pickPoolMember({ mode: pool.mode, levels: pool.levels ?? AI_POOL_LEVELS, floor: pool.floor ?? 0, members, currentIndex: -1, fresh: true });
  return members[picked.index]?.eligible ? picked.index : undefined;
}

export function poolPick(pool: AiPool, instances: readonly InstanceInfo[], limits: readonly EngineLimit[], current: ModelSelection, now: number): ModelSelection | undefined {
  const usable = pool.members.filter((member) => {
    const instance = instances.find((candidate) => candidate.instanceId === member.instanceId);
    return instance !== undefined && poolReady(instance) && leftOf(instance, limits, now) !== 0;
  });
  if (usable.some((member) => member.instanceId === current.instanceId)) return current;
  if (pool.mode === "turns") {
    const plan = usable.find((member) => !billsEachUse(instances.find((candidate) => candidate.instanceId === member.instanceId)!));
    return plan ?? usable[0];
  }
  const next = nextPoolMember(pool, instances, limits, now);
  return next === undefined ? usable[0] : pool.members[next];
}

export interface PoolTaskMark {
  modelSelection: ModelSelection;
  aiPool?: "auto" | "pinned" | undefined;
  followsBotModel?: boolean | undefined;
}

export function poolRuns(pool: AiPool | undefined, task: PoolTaskMark | undefined, botModel: ModelSelection | undefined): boolean {
  if (!pool || !task) return false;
  const member = (selection: ModelSelection | undefined) => pool.members.some((entry) => entry.instanceId === selection?.instanceId);
  if (task.aiPool === "auto") return member(task.modelSelection);
  return task.aiPool === undefined && task.followsBotModel === true && member(botModel);
}

export const AI_POOL_STEP_CHOICES = ["10", "20", "25"] as const;

export function stepsOf(levels: readonly number[] | undefined, reserve = 0): PoolSteps {
  if (!levels) return "10";
  const same = (preset: readonly number[]) => preset.length === levels.length && preset.every((level, index) => level === levels[index]);
  return AI_POOL_STEP_CHOICES.find((key) => same(AI_POOL_STEPS[key].filter((level) => level > reserve))) ?? "custom";
}

export const MODE_LABEL_KEY = { even: "settings.aiPool.modeEven", turns: "settings.aiPool.modeTurns", inOrder: "settings.aiPool.modeInOrder" } as const satisfies Record<AiPoolMode, string>;

/** The levels a step choice saves for a reserve: the choice's levels above the reserve; none saved for the default list. */
export function levelsFor(steps: Exclude<PoolSteps, "custom">, reserve: number): number[] | undefined {
  const levels = AI_POOL_STEPS[steps].filter((level) => level > reserve);
  return steps === "10" && levels.length === AI_POOL_STEPS["10"].length ? undefined : levels;
}
