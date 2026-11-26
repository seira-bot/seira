import { useEffect, useRef, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { SETTINGS_INLINE_INPUT, SettingRow, SettingsGroup, SettingsRows } from "./SettingsPrimitives";

const MIN_DAYS = 1;
const MAX_DAYS = 3650;

function parseDays(value: string): number | null {
  const days = Number(value);
  return value.trim() !== "" && Number.isInteger(days) && days >= MIN_DAYS && days <= MAX_DAYS ? days : null;
}

/** How many days the record of what bots were allowed or refused is kept. */
export function ApprovalHistorySetting() {
  const { state, dispatch } = useStore();
  const confirmed = state.config?.decisions?.retentionDays;
  const fixed = state.config?.decisions?.fixed === true;
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);

  useEffect(() => {
    if (draft !== null && confirmed !== undefined && String(confirmed) === draft) setDraft(null);
  }, [confirmed, draft]);

  if (confirmed === undefined) return null;
  const value = draft ?? String(confirmed);

  const commit = async () => {
    if (saving.current || fixed) return;
    const days = parseDays(value);
    if (days === null) { setError(t("settings.data.approvalHistory.invalid")); return; }
    if (days === confirmed) { setDraft(null); setError(""); return; }
    saving.current = true;
    setPending(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", { method: "PUT", body: JSON.stringify({ decisions: { retentionDays: days } }) });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.data.approvalHistory.error"));
    } finally {
      saving.current = false;
      setPending(false);
    }
  };

  return (
    <SettingsGroup label={t("settings.data.approvalHistory.title")} block="approval-history">
      <SettingsRows>
        <SettingRow title={t("settings.data.approvalHistory.days")} subtitle={t("settings.data.approvalHistory.subtitle")}
          inert={fixed ? t("settings.data.approvalHistory.fixed") : undefined}
          inertText={fixed ? t("settings.data.approvalHistory.fixed") : undefined}
          message={pending ? <span role="status">{t("settings.data.approvalHistory.saving")}</span>
            : error ? <span role="alert" className="text-danger">{error}</span> : undefined}>
          <input
            id="approval-history-days"
            type="number"
            min={MIN_DAYS}
            max={MAX_DAYS}
            step={1}
            inputMode="numeric"
            value={value}
            disabled={fixed || pending}
            aria-invalid={error !== ""}
            aria-label={t("settings.data.approvalHistory.days")}
            onChange={(event) => { setDraft(event.target.value); setError(""); }}
            onBlur={() => void commit()}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
            className={cn(SETTINGS_INLINE_INPUT, error && "border-danger/60")}
          />
        </SettingRow>
      </SettingsRows>
    </SettingsGroup>
  );
}
