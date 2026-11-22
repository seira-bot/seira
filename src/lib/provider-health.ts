import { useCallback } from "react";
import type { InstanceInfo } from "@/state/store";
import { needsCli, needsSignIn } from "@/components/EngineSetup";
import { isCustomOnly } from "./engine-rail";
import { t } from "./i18n";
import { reportsUsage, useEngineLimits, usageTone, type EngineLimit } from "./limit-resets";

export interface ProviderHealth {
  usable: boolean;
  /** Why a provider is not usable, in the words the menus show. */
  reason?: string;
}

/** A provider that needs a CLI, a sign-in or a key, that its organization blocks, or that is at its usage limit cannot
 * start a task now. A CLI update only blocks some models, so it stays usable. */
export function providerHealth(instance: InstanceInfo, limit?: EngineLimit): ProviderHealth {
  if (instance.policy) return { usable: false, reason: t("policy.managedBy", { organization: instance.policy.organizationName }) };
  if (needsCli(instance)) return { usable: false, reason: t("model.setupRequired") };
  if (needsSignIn(instance) && !isCustomOnly(instance)) return { usable: false, reason: t("model.signInRequired") };
  if (reportsUsage(limit) && usageTone(limit) === "out") return { usable: false, reason: t("limits.atLimit", { engine: limit.name }) };
  return { usable: true };
}

/** Usable providers first; each group keeps its own order. */
export function byHealth<T>(items: readonly T[], health: (item: T) => ProviderHealth): T[] {
  const usable = items.filter((item) => health(item).usable);
  return [...usable, ...items.filter((item) => !usable.includes(item))];
}

export type HealthOf = (instance: InstanceInfo) => ProviderHealth;

/** The providers in the order a person should meet them, and the health each one has right now. */
export function useProviderOrder(instances: readonly InstanceInfo[]): { listed: InstanceInfo[]; health: HealthOf } {
  const limits = useEngineLimits();
  const health = useCallback<HealthOf>((instance) => providerHealth(instance, limits.find((limit) => limit.engine === instance.instanceId)), [limits]);
  return { listed: byHealth(instances, health), health };
}
