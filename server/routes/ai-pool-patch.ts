import { samePlanPair, type AiPoolConfig } from "../ai-pool.ts";
import type { InstanceConfigMap, ModelSelection } from "../contracts.ts";
import { billsEachUse } from "../limit-failover.ts";
import type { ModelSelectionCheck } from "./config.ts";

export interface AiPoolPatchDeps {
  check(raw: unknown): ModelSelectionCheck;
  engine(instanceId: string): { instanceId: string; driverKind: string; enabled: boolean; displayName?: string | undefined } | undefined;
  configs(): InstanceConfigMap;
  policyRefusal(engine: { instanceId: string; driverKind: string }): string | undefined;
}

export type AiPoolPatchResult = { ok: true; members: ModelSelection[] } | { ok: false; status: number; body: Record<string, unknown> };

export const SAME_PLAN_POOL_ERROR = "Two sign-ins to the same AI plan can't share a pool, because the provider's terms don't allow it. Use a pay-per-use key for the second one.";

export function checkedAiPoolMembers(members: AiPoolConfig["members"], deps: AiPoolPatchDeps): AiPoolPatchResult {
  const checkedMembers: ModelSelection[] = [], engines = [];
  for (const member of members) {
    const checked = deps.check(member);
    if (!checked.ok) {
      const { status, ...body } = checked;
      return { ok: false, status, body };
    }
    const engine = deps.engine(checked.selection.instanceId)!;
    if (!engine.enabled) return { ok: false, status: 400, body: { error: `Turn on ${engine.displayName ?? engine.instanceId} before you add it to the AI pool.` } };
    const refusal = deps.policyRefusal(engine);
    if (refusal) return { ok: false, status: 403, body: { error: refusal, code: "managed_policy" } };
    checkedMembers.push(checked.selection);
    engines.push({ instanceId: engine.instanceId, driverKind: engine.driverKind, billsEachUse: billsEachUse(deps.configs()[engine.instanceId]) });
  }
  if (samePlanPair(engines)) return { ok: false, status: 400, body: { error: SAME_PLAN_POOL_ERROR } };
  return { ok: true, members: checkedMembers };
}
