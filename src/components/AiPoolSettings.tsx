import { useRef, useState, type KeyboardEvent } from "react";
import { api, useStore, type ConfigStatus, type ModelSelection } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { AI_POOL_MODES, AI_POOL_RESERVES, type AiPoolMode } from "../../shared/ai-pool";
import { AI_POOL_STEP_CHOICES, levelsFor, MODE_LABEL_KEY, isPaidMember, memberBilling, nextPoolMember, stepsOf, suggestPaidMembers, suggestPoolMembers, type AiPool, type PoolSteps } from "@/lib/ai-pool";
import { useEngineLimits } from "@/lib/limit-resets";
import { SettingRow, SettingsFoldRow, SettingsRows, Switch } from "./SettingsPrimitives";
import { Select } from "./Select";
import { AddRows, MemberRows, textButton } from "./AiPoolMembers";

const MODE_LINE_KEY = { even: "settings.aiPool.modeEvenLine", turns: "settings.aiPool.modeTurnsLine", inOrder: "settings.aiPool.modeInOrderLine" } as const satisfies Record<AiPoolMode, string>;

const PAID_LINE_KEY = { even: "settings.aiPool.paidModeEven", turns: "settings.aiPool.paidModeTurns", inOrder: "settings.aiPool.paidModeInOrder" } as const satisfies Record<AiPoolMode, string>;

/** Members the pool would use, split by how they bill. Nothing here is saved until the owner picks. */
interface PaidReview { plans: ModelSelection[]; paid: ModelSelection[]; unknown: ModelSelection[]; all: ModelSelection[] }

function ModeChoice({ mode, disabled, onChange }: { mode: AiPoolMode; disabled: boolean; onChange: (mode: AiPoolMode) => void }) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const by = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!by || disabled) return;
    event.preventDefault();
    const at = (AI_POOL_MODES.indexOf(mode) + by + AI_POOL_MODES.length) % AI_POOL_MODES.length;
    event.currentTarget.querySelectorAll<HTMLElement>("[role=radio]")[at]?.focus();
    onChange(AI_POOL_MODES[at]!);
  };
  return (
    <div role="radiogroup" aria-label={t("settings.aiPool.mode")} aria-disabled={disabled || undefined} data-settings-segmented="" onKeyDown={onKeyDown}
      className={cn("inline-flex h-7 items-center rounded-full bg-ink/[0.05] p-0.5", disabled && "opacity-40")}>
      {AI_POOL_MODES.map((value) => (
        <button key={value} type="button" role="radio" aria-checked={mode === value} tabIndex={mode === value ? 0 : -1} onClick={() => !disabled && onChange(value)}
          className={cn("h-6 cursor-pointer rounded-full px-3 text-[13px] leading-5 transition-colors focus-visible:outline-2 focus-visible:outline-focus",
            mode === value ? "bg-menu font-medium text-ink shadow-[inset_0_0_0_0.5px_var(--settings-edge)]" : "text-ink-secondary hover:text-ink")}>
          {t(MODE_LABEL_KEY[value])}
        </button>
      ))}
    </div>
  );
}

/** Reserve and steps keep the saved levels all above the reserve, so the pair always passes the server's check. */
function withReserve(pool: AiPool, floor: number): AiPool {
  const steps = stepsOf(pool.levels, pool.floor ?? 0);
  const levels = steps === "custom" ? pool.levels?.filter((level) => level > floor) : levelsFor(steps, floor);
  const { levels: _levels, floor: _floor, ...rest } = pool;
  return { ...rest, ...(levels?.length ? { levels } : {}), ...(floor > 0 ? { floor } : {}) };
}

function withSteps(pool: AiPool, steps: Exclude<PoolSteps, "custom">): AiPool {
  const { levels: _levels, ...rest } = pool;
  const levels = levelsFor(steps, pool.floor ?? 0);
  return { ...rest, ...(levels ? { levels } : {}) };
}

/** AI pool: one card. Every change saves at once. Turning it on fills the list from the AIs that are signed in. */
export function AiPoolSettings() {
  const { state, dispatch } = useStore();
  const limits = useEngineLimits();
  const [draft, setDraft] = useState<AiPool | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [needsSecond, setNeedsSecond] = useState(false);
  const [foldOpen, setFoldOpen] = useState(false);
  const [review, setReview] = useState<PaidReview | null>(null);
  const inFlight = useRef(false);
  const saved = state.config?.aiPool;
  const value: AiPool = draft ?? saved ?? { enabled: false, mode: "even", members: [] };
  const now = Date.now();
  const bots = state.bots.filter((bot) => !bot.hidden);
  const inPool = new Set(value.members.map((member) => member.instanceId));
  const idle = bots.filter((bot) => !inPool.has(bot.modelSelection.instanceId));
  const reserve = value.floor ?? 0;
  const steps = stepsOf(value.levels, reserve);
  const next = value.enabled ? nextPoolMember(value, state.instances, limits, now) : undefined;
  const openProviders = () => dispatch({ type: "toggleAppSettings", open: true, section: "engines" });

  const save = async (pool: AiPool) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const config = await api<ConfigStatus>("/api/config", {
        method: "PUT",
        body: JSON.stringify({ aiPool: { enabled: pool.enabled, mode: pool.mode, members: pool.members, ...(pool.levels ? { levels: pool.levels } : {}), ...(pool.floor ? { floor: pool.floor } : {}) } }),
      });
      dispatch({ type: "configStatus", config });
      setDraft(null);
    } catch (cause) {
      setDraft(null);
      setError(cause instanceof Error ? cause.message : t("settings.aiPool.error"));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  const change = (pool: AiPool) => {
    setDraft(pool);
    setNotice("");
    setNeedsSecond(false);
    setReview(null);
    void save(pool);
  };
  const nameOf = (members: readonly ModelSelection[]) => members.map((member) => state.instances.find((instance) => instance.instanceId === member.instanceId)?.displayName ?? member.instanceId).join(", ");
  /** What turning the pool on would use, read from the AIs as they are now. The owner sees this exact list before anything is saved. */
  const reviewOf = (): PaidReview => {
    const kept = value.members.length >= 2;
    const members = kept ? value.members : suggestPoolMembers(state.instances, limits, now);
    const billing = (member: ModelSelection) => memberBilling(member, state.instances);
    const plans = members.filter((member) => billing(member) === "plan");
    const unknown = members.filter((member) => billing(member) === "unknown");
    const paid = kept ? members.filter((member) => billing(member) === "paid") : suggestPaidMembers(state.instances, plans);
    return { plans, paid, unknown, all: kept ? members : [...plans, ...paid] };
  };
  const toggle = () => {
    if (value.enabled) return change({ ...value, enabled: false });
    const next = reviewOf();
    setNotice("");
    setNeedsSecond(false);
    setReview(null);
    if (next.unknown.length > 0) {
      setReview(null);
      return setNotice(t("settings.aiPool.billingUnknown", { names: nameOf(next.unknown) }));
    }
    if (next.paid.length > 0) return setReview(next);
    if (next.plans.length < 2) return setNeedsSecond(true);
    change({ ...value, enabled: true, members: next.plans });
  };
  const decide = (includePaid: boolean) => {
    if (!review) return;
    const next = reviewOf();
    if (next.unknown.length > 0 || next.paid.length === 0) {
      setReview(null);
      return setNotice(next.unknown.length > 0 ? t("settings.aiPool.billingUnknown", { names: nameOf(next.unknown) }) : t("settings.aiPool.reviewChanged"));
    }
    const members = includePaid ? next.all : next.plans;
    setReview(null);
    if (members.length < 2) return setNeedsSecond(true);
    change({ ...value, enabled: true, members });
  };
  /** While the question is open it is read again on every render: if the AIs change, the owner sees the new list before choosing. */
  const shown = review ? reviewOf() : null;
  const reviewOpen = shown !== null && shown.unknown.length === 0 && shown.paid.length > 0;
  const reviewNote = shown && !reviewOpen ? (shown.unknown.length > 0 ? t("settings.aiPool.billingUnknown", { names: nameOf(shown.unknown) }) : t("settings.aiPool.reviewChanged")) : "";
  const setMembers = (members: ModelSelection[]) => {
    if (members.length >= 2) return change({ ...value, members });
    change({ ...value, enabled: false, members });
    setNotice(t("settings.aiPool.turnedOff"));
  };
  const message = <>
    {error && <span role="alert" className="block text-danger">{error}</span>}
    {saving && <span role="status" className="block">{t("settings.threads.saving")}</span>}
    {notice && <span role="status" className="block">{notice}</span>}
    {reviewNote && <span role="status" className="block">{reviewNote}</span>}
    {needsSecond && <span className="flex flex-wrap items-center gap-2">
      <span>{t("settings.aiPool.needSecond")}</span>
      <button type="button" className="cursor-pointer text-accent-text hover:underline focus-visible:underline" onClick={openProviders}>{t("settings.aiPool.addAi")}</button>
    </span>}
    {value.enabled && !error && !saving && !notice && <span data-ai-pool-status="">{t("settings.aiPool.status", { count: value.members.length, bots: bots.length - idle.length, total: bots.length })}</span>}
  </>;
  const list = { pool: value, instances: state.instances, limits, now, saving, next, onMembers: setMembers, onSignIn: openProviders };
  const stepOptions = [...AI_POOL_STEP_CHOICES, ...(steps === "custom" ? ["custom" as const] : [])];
  const reserves = AI_POOL_RESERVES.includes(reserve) ? AI_POOL_RESERVES : [...AI_POOL_RESERVES, reserve];
  return (
    <SettingsRows selectWidth={200}>
      <SettingRow title={t("settings.pool.title")} subtitle={<span id="ai-pool-help">{t("settings.aiPool.short")}</span>} message={message}>
        <Switch id="ai-pool-enabled" checked={value.enabled} disabled={saving || !state.config} aria-label={t("settings.pool.title")} aria-describedby="ai-pool-help" onClick={toggle} />
      </SettingRow>
      {shown && reviewOpen && <SettingRow title={t("settings.aiPool.paidTitle")} subtitle={<span data-ai-pool-paid-review="" className="block">
        {shown.plans.length > 0 && <span className="block">{t("settings.aiPool.paidPlans", { names: nameOf(shown.plans) })}</span>}
        <span className="block">{t("settings.aiPool.paidLine", { names: nameOf(shown.paid) })}</span>
        <span className="block">{t(PAID_LINE_KEY[value.mode])}</span>
      </span>}>
        <button type="button" className={textButton} disabled={saving} onClick={() => decide(false)}>{t("settings.aiPool.paidSkip")}</button>
        <button type="button" className={textButton} disabled={saving} onClick={() => decide(true)}>{t("settings.aiPool.paidInclude")}</button>
      </SettingRow>}
      {value.enabled && <SettingRow title={t("settings.aiPool.mode")} subtitle={value.members.some((member) => isPaidMember(member, state.instances)) ? `${t(MODE_LINE_KEY[value.mode])} ${t(PAID_LINE_KEY[value.mode])}` : t(MODE_LINE_KEY[value.mode])}>
        <ModeChoice mode={value.mode} disabled={saving} onChange={(mode) => change({ ...value, mode })} />
      </SettingRow>}
      {value.enabled && <MemberRows {...list} />}
      {value.enabled && <AddRows {...list} />}
      {value.enabled && <SettingsFoldRow id="ai-pool-more" title={t("settings.aiPool.more")} open={foldOpen} onToggle={() => setFoldOpen(!foldOpen)}>
        <SettingRow title={t("settings.aiPool.reserve")} subtitle={t("settings.aiPool.reserveLine")}>
          <Select id="ai-pool-reserve" aria-label={t("settings.aiPool.reserve")} value={String(reserve)} disabled={saving} onChange={(event) => change(withReserve(value, Number(event.target.value)))}>
            {reserves.map((percent) => <option key={percent} value={percent}>{percent === 0 ? t("settings.aiPool.reserveNone") : t("settings.aiPool.percent", { percent })}</option>)}
          </Select>
        </SettingRow>
        {value.mode === "even" && <SettingRow title={t("settings.aiPool.steps")} subtitle={t("settings.aiPool.stepsLine")}>
          <Select id="ai-pool-steps" aria-label={t("settings.aiPool.steps")} value={steps} disabled={saving}
            onChange={(event) => { const choice = AI_POOL_STEP_CHOICES.find((key) => key === event.target.value); if (choice) change(withSteps(value, choice)); }}>
            {stepOptions.map((key) => <option key={key} value={key}>{key === "custom" ? t("settings.aiPool.stepsCustom") : t("settings.aiPool.percent", { percent: key })}</option>)}
          </Select>
        </SettingRow>}
      </SettingsFoldRow>}
      {value.enabled && idle.length > 0 && <details data-ai-pool-idle="" className="px-4 py-3 text-[13px] leading-[18px] text-ink-secondary">
        <summary className="cursor-pointer text-ink">{t("settings.aiPool.idle", { count: idle.length })}</summary>
        <ul className="mt-1.5">{idle.map((bot) => <li key={bot.id}>{bot.name}</li>)}</ul>
        <p className="mt-1.5 text-[12px] leading-4">{t("settings.aiPool.idleLine")}</p>
      </details>}
    </SettingsRows>
  );
}
