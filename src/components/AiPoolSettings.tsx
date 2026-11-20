import { useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { api, useStore, type ConfigStatus, type ModelSelection } from "@/state/store";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { cn } from "@/lib/cn";
import { LearnMore, SETTINGS_INLINE_INPUT, SettingRow, SettingsFoldRow, SettingsRows, Switch } from "./SettingsPrimitives";
import { Select } from "./Select";

type Pool = NonNullable<ConfigStatus["aiPool"]>;

const MAX_MEMBERS = 10;
const DEFAULT_LEVELS = "90, 80, 70, 60, 50, 40, 30, 20, 10";
const LAST_DEFAULT_LEVEL = 10;

function readLevels(text: string): { levels?: number[]; error?: LocaleKey } {
  const words = text.split(/[\s,]+/).filter(Boolean);
  if (!words.length) return {};
  if (words.some((word) => !/^\d+$/.test(word) || Number(word) < 1 || Number(word) > 99)) return { error: "settings.pool.levelsNumbers" };
  const levels = words.map(Number);
  if (levels.length > 9) return { error: "settings.pool.levelsCount" };
  if (levels.some((level, index) => index > 0 && level >= levels[index - 1]!)) return { error: "settings.pool.levelsFalling" };
  return { levels };
}

function readFloor(text: string, levels: number[] | undefined): { floor?: number; error?: LocaleKey } {
  const word = text.trim();
  if (!word) return {};
  if (!/^\d+$/.test(word) || Number(word) > 98) return { error: "settings.pool.floorNumber" };
  const floor = Number(word);
  if (floor >= (levels?.at(-1) ?? LAST_DEFAULT_LEVEL)) return { error: "settings.pool.floorLow" };
  return { floor };
}

/** AI pool: one card of rows. It saves as you go: turning it off saves at once, and any change while it is on saves as
 * soon as the pool is complete (two or more AIs, valid levels and floor); until then the status line says what is
 * missing. The mode, the AIs and the advanced fold show only while the switch is on. */
export function AiPoolSettings() {
  const { state, dispatch } = useStore();
  const [draft, setDraft] = useState<Pool | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [more, setMore] = useState(false);
  const inFlight = useRef(false);
  const [levelsText, setLevelsText] = useState<string | null>(null);
  const [floorText, setFloorText] = useState<string | null>(null);
  const [foldOpen, setFoldOpen] = useState(false);
  const [addEngine, setAddEngine] = useState("");
  const saved = state.config?.aiPool;
  const value: Pool = draft ?? saved ?? { enabled: false, mode: "even", members: [] };
  const levelsShown = levelsText ?? value.levels?.join(", ") ?? "";
  const floorShown = floorText ?? (value.floor === undefined ? "" : String(value.floor));
  const levelsRead = readLevels(levelsShown);
  const floorRead = readFloor(floorShown, levelsRead.levels);
  const engines = state.instances.filter((instance) => instance.snapshot.state === "available" && !instance.policy);
  const engineOf = (id: string) => engines.find((instance) => instance.instanceId === id);
  const modelsOf = (id: string) => {
    const found = engineOf(id);
    return found?.models.options.filter((model) => !model.orgBlocked && !model.needsCliUpdate && (found.snapshot.authenticated !== false || model.custom)) ?? [];
  };
  const nameOf = (member: ModelSelection) => engineOf(member.instanceId)?.displayName ?? member.instanceId;
  const modelLabel = (member: ModelSelection) => {
    const found = engineOf(member.instanceId);
    if (!found) return t("settings.recovery.unavailable", { name: member.model });
    return found.models.options.find((model) => model.id === member.model)?.label ?? member.model;
  };
  const taken = new Set(value.members.map((member) => member.instanceId));
  const addable = engines.filter((instance) => !taken.has(instance.instanceId));
  const addModels = modelsOf(addEngine);
  const needsMore = value.enabled && value.members.length < 2;
  const valid = !levelsRead.error && !floorRead.error;

  const save = async (next: Pool) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError("");
    const levels = levelsRead.error ? saved?.levels : levelsRead.levels;
    const floor = floorRead.error ? saved?.floor : floorRead.floor;
    try {
      const config = await api<ConfigStatus>("/api/config", {
        method: "PUT",
        body: JSON.stringify({ aiPool: { enabled: next.enabled, mode: next.mode, members: next.members, ...(levels ? { levels } : {}), ...(floor !== undefined ? { floor } : {}) } }),
      });
      dispatch({ type: "configStatus", config });
      setDraft(null);
      setLevelsText(null);
      setFloorText(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.pool.error"));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  const change = (next: Pool) => {
    setDraft(next);
    setError("");
    if (!next.enabled || (next.members.length >= 2 && valid)) void save(next);
  };
  const members = (next: ModelSelection[]) => change({ ...value, members: next });
  const move = (index: number, by: -1 | 1) => {
    const next = [...value.members];
    [next[index], next[index + by]] = [next[index + by]!, next[index]!];
    members(next);
  };
  const status = error ? <span role="alert" className="text-danger">{error}</span>
    : saving ? <span role="status">{t("settings.threads.saving")}</span>
    : needsMore ? t("settings.pool.needTwo") : undefined;
  const fieldError = (id: string, key: LocaleKey | undefined) => key ? <span id={id} role="alert" className="text-danger">{t(key)}</span> : undefined;
  const commit = () => { if (levelsText !== null || floorText !== null) change(value); };
  const onEnter = (event: { key: string; currentTarget: { blur: () => void } }) => { if (event.key === "Enter") event.currentTarget.blur(); };
  const iconButton = "settings-quiet cursor-pointer disabled:cursor-default disabled:opacity-40";
  return (
    <SettingsRows selectWidth={200}>
      <SettingRow title={t("settings.pool.title")}
        subtitle={<span id="ai-pool-help">{t("settings.pool.short")}{" "}<LearnMore onClick={() => setMore((open) => !open)} /></span>}
        message={more || (!value.enabled && error) ? <span data-ai-pool-more="" className="flex flex-col gap-1">
          {more && <>
            <span>{t("settings.pool.helpEven")}</span>
            <span>{t("settings.pool.helpInOrder")}</span>
            <span>{t("settings.pool.helpSamePlan")}</span>
            <span>{t("settings.pool.helpPayPerUse")}</span>
          </>}
          {!value.enabled && error && <span role="alert" className="text-danger">{error}</span>}
        </span> : undefined}>
        <Switch id="ai-pool-enabled" checked={value.enabled} disabled={saving || !state.config} aria-label={t("settings.pool.title")}
          aria-describedby="ai-pool-help" onClick={() => change({ ...value, enabled: !value.enabled })} />
      </SettingRow>
      {value.enabled && <SettingRow title={t("settings.pool.mode")}>
        <Select id="ai-pool-mode" aria-label={t("settings.pool.mode")} value={value.mode} disabled={saving}
          onChange={(event) => change({ ...value, mode: event.target.value === "inOrder" ? "inOrder" : "even" })}>
          <option value="even">{t("settings.pool.modeEven")}</option>
          <option value="inOrder">{t("settings.pool.modeInOrder")}</option>
        </Select>
      </SettingRow>}
      {value.enabled && value.members.map((member, index) => <SettingRow key={member.instanceId} title={nameOf(member)} subtitle={modelLabel(member)}>
        <button type="button" className={iconButton} disabled={saving || index === 0} aria-label={t("settings.pool.moveUp", { name: nameOf(member) })} onClick={() => move(index, -1)}><ChevronUp size={14} aria-hidden="true" /></button>
        <button type="button" className={iconButton} disabled={saving || index === value.members.length - 1} aria-label={t("settings.pool.moveDown", { name: nameOf(member) })} onClick={() => move(index, 1)}><ChevronDown size={14} aria-hidden="true" /></button>
        <button type="button" className={iconButton} disabled={saving} aria-label={t("settings.pool.remove", { name: nameOf(member) })} onClick={() => members(value.members.filter((_, at) => at !== index))}><X size={14} aria-hidden="true" /></button>
      </SettingRow>)}
      {value.enabled && value.members.length < MAX_MEMBERS && addable.length > 0 && <SettingRow title={t("settings.pool.add")}>
        <Select id="ai-pool-add-engine" aria-label={t("settings.pool.add")} value={addEngine} disabled={saving} onChange={(event) => setAddEngine(event.target.value)}>
          <option value="">{t("settings.pool.chooseAi")}</option>
          {addable.map((instance) => <option key={instance.instanceId} value={instance.instanceId}
            disabled={!instance.models.options.some((model) => instance.snapshot.authenticated !== false || model.custom)}>{instance.displayName}</option>)}
        </Select>
      </SettingRow>}
      {value.enabled && addEngine && !taken.has(addEngine) && <SettingRow title={t("settings.pool.model")}>
        <Select id="ai-pool-add-model" aria-label={t("settings.pool.model")} value="" disabled={saving}
          onChange={(event) => {
            if (!event.target.value) return;
            setAddEngine("");
            members([...value.members, { instanceId: addEngine, model: event.target.value }]);
          }}>
          <option value="">{t("settings.pool.chooseModel")}</option>
          {addModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
        </Select>
      </SettingRow>}
      {value.enabled && value.members.length >= MAX_MEMBERS && <div className="px-4 py-3 text-[12px] leading-4 text-ink-secondary">{t("settings.pool.full")}</div>}
      {value.enabled && status && <div data-ai-pool-status="" className="px-4 py-3 text-[12px] leading-4 text-ink-secondary">{status}</div>}
      {value.enabled && <SettingsFoldRow id="ai-pool-more" title={t("settings.pool.more")} open={foldOpen} onToggle={() => setFoldOpen(!foldOpen)}>
        <SettingRow title={t("settings.pool.levels")} subtitle={t("settings.pool.levelsLine")} message={fieldError("ai-pool-levels-error", levelsRead.error)}>
          <input id="ai-pool-levels" type="text" inputMode="numeric" value={levelsShown} placeholder={DEFAULT_LEVELS} disabled={saving}
            aria-label={t("settings.pool.levels")} aria-invalid={Boolean(levelsRead.error)} aria-describedby={levelsRead.error ? "ai-pool-levels-error" : undefined}
            onChange={(event) => { setLevelsText(event.target.value); setError(""); }} onBlur={commit} onKeyDown={onEnter}
            className={cn(SETTINGS_INLINE_INPUT, "w-[200px] text-left", levelsRead.error && "border-danger/60")} />
        </SettingRow>
        <SettingRow title={t("settings.pool.floor")} subtitle={t("settings.pool.floorLine")} message={fieldError("ai-pool-floor-error", floorRead.error)}>
          <input id="ai-pool-floor" type="number" min={0} max={98} step={1} inputMode="numeric" value={floorShown} placeholder="0" disabled={saving}
            aria-label={t("settings.pool.floor")} aria-invalid={Boolean(floorRead.error)} aria-describedby={floorRead.error ? "ai-pool-floor-error" : undefined}
            onChange={(event) => { setFloorText(event.target.value); setError(""); }} onBlur={commit} onKeyDown={onEnter}
            className={cn(SETTINGS_INLINE_INPUT, floorRead.error && "border-danger/60")} />
        </SettingRow>
      </SettingsFoldRow>}
    </SettingsRows>
  );
}
