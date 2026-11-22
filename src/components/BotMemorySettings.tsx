import { SETTINGS_INLINE_INPUT, SettingRow } from "./SettingsPrimitives";
import { cn } from "@/lib/cn";
import { useEffect, useRef, useState } from "react";

import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";

const gbText = (gb: number | null | undefined) => (gb == null ? "" : String(gb));

export function BotMemorySettings() {
  const { state, dispatch } = useStore();
  const memory = state.config?.botMemory;
  const confirmed = memory ? (memory.envGb ?? memory.gb) : null;
  const [value, setValue] = useState(gbText(confirmed));
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);

  useEffect(() => {
    if (!dirty) setValue(gbText(confirmed));
  }, [confirmed, dirty]);

  if (!memory) return null;
  const fixed = memory.envGb !== null;

  const save = async () => {
    if (!dirty || fixed || saveInFlight.current) return;
    const text = value.trim();
    let gb: number | null = null;
    if (text !== "") {
      gb = Number(text);
      if (!Number.isFinite(gb) || gb < 1 || gb > memory.machineGb) {
        setError(t("settings.botMemory.range", { max: memory.machineGb }));
        return;
      }
    }
    saveInFlight.current = true;
    setSaving(true);
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PUT",
        body: JSON.stringify({ botMemoryGb: gb }),
      });
      dispatch({ type: "configStatus", config });
      setValue(gbText(config.botMemory?.gb));
      setDirty(false);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("settings.botMemory.error"));
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  const note = error
    ? <span id="bot-memory-error" role="alert" className="text-danger">{error}</span>
    : fixed
      ? <span id="bot-memory-fixed" className="text-ink-secondary">{t("settings.botMemory.fixed", { gb: String(memory.envGb) })}</span>
      : undefined;

  return (
    <SettingRow title={t("settings.botMemory.title")} subtitle={t("settings.botMemory.subtitle")} message={note}>
      <span className="flex w-[160px] items-center gap-2 text-[13px] leading-5 text-ink-secondary">
        <input
          id="bot-memory"
          type="number"
          min={1}
          max={memory.machineGb}
          step="any"
          inputMode="decimal"
          value={value}
          placeholder={t("settings.botMemory.auto", { gb: memory.autoGb })}
          disabled={saving || fixed}
          aria-label={t("settings.botMemory.title")}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "bot-memory-error" : fixed ? "bot-memory-fixed" : undefined}
          title={t("settings.botMemory.help")}
          onChange={(event) => {
            setValue(event.target.value);
            setDirty(true);
            setError("");
          }}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className={cn(SETTINGS_INLINE_INPUT, "w-auto min-w-0 flex-1", error && "border-danger/60")}
        />
        {t("settings.botMemory.gb")}
      </span>
    </SettingRow>
  );
}
