import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { InstanceInfo, ModelSelection } from "@/state/store";
import { memberStatus, planConflict, poolReady, isSignedOut, usableModels, MAX_POOL_MEMBERS, type AiPool, type PoolStatus } from "@/lib/ai-pool";
import type { EngineLimit } from "@/lib/limit-resets";
import { resetTime } from "@/lib/limit-resets";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { InstanceProviderMark } from "./ProviderIcons";
import { SettingRow } from "./SettingsPrimitives";
import { UsageRing } from "./EngineUsage";
import { Select } from "./Select";

export interface PoolListProps {
  pool: AiPool;
  instances: readonly InstanceInfo[];
  limits: readonly EngineLimit[];
  now: number;
  saving: boolean;
  next: number | undefined;
  onMembers: (members: ModelSelection[]) => void;
  onSignIn: () => void;
}

const iconButton = "settings-quiet cursor-pointer disabled:cursor-default disabled:opacity-40";

export function statusText(status: PoolStatus): string {
  switch (status.state) {
    case "paid": return t("settings.aiPool.paid");
    case "signedOut": return t("settings.aiPool.signedOut");
    case "unknown": return t("settings.aiPool.unknown");
    case "out": {
      const base = status.left === null ? t("settings.aiPool.unavailable") : t("settings.aiPool.atLimit");
      return status.left !== null && status.resetsAt !== null ? `${base} · ${t("settings.aiPool.resets", { time: resetTime(status.resetsAt) })}` : base;
    }
    default: {
      const base = t("settings.aiPool.left", { percent: status.left ?? 0 });
      return status.resetsAt === null ? base : `${base} · ${t("settings.aiPool.resets", { time: resetTime(status.resetsAt) })}`;
    }
  }
}

function StatusLine({ status, limit }: { status: PoolStatus; limit: EngineLimit | undefined }) {
  const ring = limit && (status.state === "ready" || status.state === "low" || status.state === "out") && status.left !== null;
  return (
    <span data-ai-pool-status-line={status.state} className="flex items-center gap-1.5">
      {ring && <UsageRing limit={limit} />}
      <span>{statusText(status)}</span>
    </span>
  );
}

const limitOf = (limits: readonly EngineLimit[], instance: InstanceInfo | undefined) => limits.find((limit) => limit.engine === instance?.instanceId);

export function MemberRows({ pool, instances, limits, now, saving, next, onMembers }: PoolListProps) {
  const reserve = pool.floor ?? 0;
  const { members } = pool;
  const move = (index: number, by: -1 | 1) => {
    const order = [...members];
    [order[index], order[index + by]] = [order[index + by]!, order[index]!];
    onMembers(order);
  };
  return <>
    {members.map((member, index) => {
      const instance = instances.find((candidate) => candidate.instanceId === member.instanceId);
      const name = instance?.displayName ?? member.instanceId;
      const models = instance ? usableModels(instance) : [];
      const limit = limitOf(limits, instance);
      return (
        <SettingRow key={member.instanceId} title={name} tag={next === index ? t("settings.aiPool.next") : undefined}
          leading={instance ? <InstanceProviderMark instance={instance} size={18} /> : undefined}
          subtitle={<StatusLine status={memberStatus(instance, limit, reserve, now)} limit={limit} />}>
          {models.length > 0 && <Select id={`ai-pool-model-${member.instanceId}`} aria-label={t("settings.aiPool.modelFor", { name })} value={member.model} disabled={saving}
            onChange={(event) => onMembers(members.map((entry, at) => at === index ? { ...entry, model: event.target.value } : entry))}>
            {!models.some((model) => model.id === member.model) && <option value={member.model}>{member.model}</option>}
            {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
          </Select>}
          <button type="button" className={iconButton} disabled={saving || index === 0} aria-label={t("settings.aiPool.moveUp", { name })} onClick={() => move(index, -1)}><ChevronUp size={14} aria-hidden="true" /></button>
          <button type="button" className={iconButton} disabled={saving || index === members.length - 1} aria-label={t("settings.aiPool.moveDown", { name })} onClick={() => move(index, 1)}><ChevronDown size={14} aria-hidden="true" /></button>
          <button type="button" className={iconButton} disabled={saving} aria-label={t("settings.aiPool.remove", { name })} onClick={() => onMembers(members.filter((_, at) => at !== index))}><X size={14} aria-hidden="true" /></button>
        </SettingRow>
      );
    })}
  </>;
}

const textButton = "h-7 shrink-0 cursor-pointer rounded-lg px-2.5 text-[13px] leading-5 text-ink shadow-[inset_0_0_0_0.5px_var(--settings-edge)] hover:bg-ink/[0.06] disabled:cursor-default disabled:opacity-40";

export function AddRows({ pool, instances, limits, now, saving, onMembers, onSignIn }: PoolListProps) {
  const taken = new Set(pool.members.map((member) => member.instanceId));
  const candidates = instances.filter((instance) => !taken.has(instance.instanceId) && instance.snapshot.state === "available" && !instance.policy
    && (isSignedOut(instance) || poolReady(instance)));
  if (candidates.length === 0) return null;
  const full = pool.members.length >= MAX_POOL_MEMBERS;
  const defaultModel = (instance: InstanceInfo) => (usableModels(instance).find((model) => model.id === instance.models.default) ?? usableModels(instance)[0])?.id;
  return <>
    <div className="px-4 pb-1 pt-3 text-[12px] font-medium leading-4 text-ink-secondary">{t("settings.aiPool.addHeading")}</div>
    {full && <div className="px-4 pb-3 text-[12px] leading-4 text-ink-secondary">{t("settings.aiPool.full")}</div>}
    {candidates.map((instance) => {
      const name = instance.displayName;
      const model = defaultModel(instance);
      const conflict = planConflict(instance, pool.members, instances);
      const signedOut = isSignedOut(instance);
      const status = memberStatus(instance, limitOf(limits, instance), pool.floor ?? 0, now);
      const swap = () => {
        const at = pool.members.findIndex((member) => member.instanceId === conflict?.instanceId);
        if (model && at >= 0) onMembers(pool.members.map((member, index) => index === at ? { instanceId: instance.instanceId, model } : member));
      };
      return (
        <SettingRow key={instance.instanceId} title={name} className={cn((conflict || signedOut) && "opacity-60")}
          leading={<InstanceProviderMark instance={instance} size={18} />}
          subtitle={conflict ? t("settings.aiPool.conflict", { name: conflict.displayName }) : <StatusLine status={status} limit={limitOf(limits, instance)} />}>
          {signedOut
            ? <button type="button" className={textButton} aria-label={t("settings.aiPool.signInTo", { name })} onClick={onSignIn}>{t("settings.aiPool.signIn")}</button>
            : conflict
              ? <button type="button" className={textButton} disabled={saving || !model} aria-label={t("settings.aiPool.useInstead", { name, other: conflict.displayName })} onClick={swap}>{t("settings.aiPool.useThis")}</button>
              : <button type="button" className={textButton} disabled={saving || full || !model} aria-label={t("settings.aiPool.addNamed", { name })}
                onClick={() => model && onMembers([...pool.members, { instanceId: instance.instanceId, model }])}>{t("settings.aiPool.add")}</button>}
        </SettingRow>
      );
    })}
  </>;
}

