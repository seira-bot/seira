import { useSyncExternalStore } from "react";
import { api, type Bot, type InstanceInfo, type ModelSelection } from "@/state/store";
import type { BotUpdatePatch } from "@/state/bot-patch-queue";
import { configuredModelInstances, signInFamily, splitEngineRail } from "./engine-rail";
import { t } from "./i18n";
import { applyTeamPlan, type TeamPlanRow } from "./team-bulk-settings";
import { byHealth, type HealthOf } from "./provider-health";

type Backup = NonNullable<Bot["fallback"]>[number];

export interface MoveTarget {
  instance: InstanceInfo;
  selection: ModelSelection;
}

export interface ProviderOffPlan {
  uses: Bot[];
  target: MoveTarget | null;
  rows: TeamPlanRow[];
}

/** One bot's model and backups before a move, so Undo can put them back. */
export interface MovedBot {
  id: string;
  name: string;
  modelSelection: ModelSelection;
  fallback?: Backup[];
}

export interface ProviderOffResult {
  instanceId: string;
  name: string;
  target?: string;
  moved: MovedBot[];
  stayed: Array<{ name: string; reason: string }>;
  hidden: boolean;
  moveOnly?: true;
  error?: string;
}

const uses = (bot: Bot, instanceId: string) =>
  bot.modelSelection.instanceId === instanceId || bot.fallback?.some((backup) => backup.instanceId === instanceId) === true;

/** The bots whose model or backup AI is this provider. */
export function providerUses(instanceId: string, bots: readonly Bot[]): Bot[] {
  return bots.filter((bot) => uses(bot, instanceId));
}

/** A provider the bots can move to; one that cannot run a task now carries the reason. */
export interface MoveChoice extends MoveTarget {
  usable: boolean;
  reason?: string;
  sameProvider: boolean;
}

const sameProviderAs = (from: InstanceInfo | undefined, other: InstanceInfo): boolean => {
  if (!from) return false;
  const family = signInFamily(from);
  if (family) return signInFamily(other) === family;
  return other.driverKind === from.driverKind && other.access === from.access && from.access !== "custom";
};

/** Every other provider with a model to offer: accounts of the same provider first, then the rest; usable ones first in each group. */
export function moveChoices(instanceId: string, instances: readonly InstanceInfo[], health: HealthOf): MoveChoice[] {
  const from = instances.find((instance) => instance.instanceId === instanceId);
  const { subscription, api: keys, custom } = splitEngineRail(configuredModelInstances(instances.filter((instance) => instance.instanceId !== instanceId)));
  const candidates = [...subscription, ...keys, ...custom];
  const same = candidates.filter((instance) => sameProviderAs(from, instance));
  const other = candidates.filter((instance) => !same.includes(instance));
  const choices: MoveChoice[] = [];
  for (const instance of [...byHealth(same, health), ...byHealth(other, health)]) {
    const model = instance.models.default || instance.models.options.find((option) => !option.orgBlocked && !option.needsCliUpdate)?.id;
    if (!model) continue;
    const { usable, reason } = health(instance);
    choices.push({ instance, selection: { instanceId: instance.instanceId, model }, usable, ...(reason ? { reason } : {}), sameProvider: same.includes(instance) });
  }
  return choices;
}

/** The first other provider that can run a task now and has a model to offer; another account of the same provider comes first. */
export function moveTarget(instanceId: string, instances: readonly InstanceInfo[], health: HealthOf): MoveTarget | null {
  const choice = moveChoices(instanceId, instances, health).find((entry) => entry.usable);
  return choice ? { instance: choice.instance, selection: choice.selection } : null;
}

const keepModel = (target: MoveTarget, current: ModelSelection): ModelSelection =>
  target.instance.models.options.some((option) => option.id === current.model && !option.orgBlocked && !option.needsCliUpdate)
    ? { ...current, instanceId: target.instance.instanceId } : target.selection;

/** Each bot moves to the target for its model and its backups, and keeps its model when the target offers it; a bot that is working stays until it is done. */
export function planProviderOff(instanceId: string, bots: readonly Bot[], target: MoveTarget | null): ProviderOffPlan {
  const used = providerUses(instanceId, bots);
  if (!target) return { uses: used, target, rows: [] };
  const rows = used.map((bot): TeamPlanRow => {
    if (bot.busy) return { bot, status: "skip", reason: t("teamSettings.skip.busy") };
    const patch: BotUpdatePatch = { keepThreadModels: true };
    const model = bot.modelSelection.instanceId === instanceId ? keepModel(target, bot.modelSelection) : bot.modelSelection;
    if (model !== bot.modelSelection) patch.modelSelection = model;
    if (bot.fallback?.some((backup) => backup.instanceId === instanceId)) {
      const taken = new Set([model.instanceId]);
      patch.fallback = bot.fallback.map((backup) => backup.instanceId === instanceId ? keepModel(target, backup) : backup)
        .filter((backup) => !taken.has(backup.instanceId) && taken.add(backup.instanceId));
    }
    return { bot, status: "apply", patch };
  });
  return { uses: used, target, rows };
}

export interface ProviderOffActions {
  persist: (bot: Bot, patch: BotUpdatePatch) => Promise<unknown>;
  hide?: () => Promise<unknown>;
  followBotModel: (bot: Bot) => Promise<unknown>;
}

/** Moves the bots, then their conversations that follow the bot's model, then hides. A bot that cannot move keeps the
 * provider visible, so nothing is left pointing at a provider that is gone. */
export async function runProviderOff(instance: Pick<InstanceInfo, "instanceId" | "displayName">, plan: ProviderOffPlan, actions: ProviderOffActions): Promise<ProviderOffResult> {
  const results = await applyTeamPlan(plan.rows, actions.persist);
  const moved: MovedBot[] = [];
  const stayed: ProviderOffResult["stayed"] = [];
  for (const row of results) {
    if (row.status === "applied") {
      moved.push({ id: row.bot.id, name: row.bot.name, modelSelection: row.bot.modelSelection, ...(row.bot.fallback ? { fallback: row.bot.fallback } : {}) });
      await actions.followBotModel(row.bot).catch(() => {});
    } else if (row.status === "skipped") stayed.push({ name: row.bot.name, reason: row.reason });
  }
  const result: ProviderOffResult = {
    instanceId: instance.instanceId, name: instance.displayName, ...(plan.target ? { target: plan.target.instance.displayName } : {}),
    moved, stayed, hidden: false,
  };
  if (stayed.length > 0) return result;
  if (!actions.hide) {
    result.moveOnly = true;
    return result;
  }
  try {
    await actions.hide();
    result.hidden = true;
  } catch (cause) {
    result.error = cause instanceof Error ? cause.message : String(cause);
  }
  return result;
}

/** Brings the provider back, then each moved bot's model and backups, then the conversations that follow the bot's model. */
export async function undoProviderOff(result: ProviderOffResult, actions: { unhide: () => Promise<unknown>; restore: (bot: MovedBot) => Promise<unknown>; followBotModel: (bot: MovedBot) => Promise<unknown> }): Promise<string[]> {
  if (result.hidden) await actions.unhide();
  const failed: string[] = [];
  for (const bot of result.moved) {
    const restored = await actions.restore(bot).then(() => true, () => { failed.push(bot.name); return false; });
    if (restored) await actions.followBotModel(bot).catch(() => {});
  }
  return failed;
}

export const followBotModelRequest = (bot: Pick<Bot, "id">) => api(`/api/bots/${encodeURIComponent(bot.id)}/threads/follow-model`, { method: "POST", body: "{}" });

let last: ProviderOffResult | null = null;
const listeners = new Set<() => void>();

/** The last Hide or Move and hide, kept outside any menu: a hidden provider's menu is gone with it, and Undo must stay. */
export function rememberProviderOff(result: ProviderOffResult | null): void {
  last = result;
  for (const listener of listeners) listener();
}

export function forgetProviderOff(instanceId: string): void {
  if (last?.instanceId === instanceId) rememberProviderOff(null);
}

export function providerOffResult(): ProviderOffResult | null {
  return last;
}

export function useProviderOffResult(): ProviderOffResult | null {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, providerOffResult, providerOffResult);
}
