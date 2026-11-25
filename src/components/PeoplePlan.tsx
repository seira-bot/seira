import { useState, type FormEvent, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { api } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { PeoplePlanStatus } from "../../shared/people-plan";

/** A date given as YYYY-MM-DD (UTC), shown as a readable date without shifting the day. */
export function planDate(day: string | undefined): string {
  const time = day ? Date.parse(`${day}T00:00:00Z`) : NaN;
  if (Number.isNaN(time)) return day ?? "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeZone: "UTC" }).format(time);
}

function PlanLink({ url, label }: { url: string; label: "people.plan.upgrade" | "people.plan.renew" }) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
      {t(label)} <ExternalLink size={12} aria-hidden="true" />
    </a>
  );
}

function Notice({ warning, id, children }: { warning?: boolean; id?: string; children: ReactNode }) {
  return (
    <p id={id} className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-relaxed text-ink-secondary", warning && "rounded-lg border border-warning/25 bg-warning/5 px-3 py-2")}>
      {children}
    </p>
  );
}

function KeyField({ onChange }: { onChange: (plan: PeoplePlanStatus) => void }) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const key = value.trim();
    if (!key || saving) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const next = (await api("/api/people/plan/key", { method: "PUT", body: JSON.stringify({ key }) })) as PeoplePlanStatus;
      setValue("");
      setSaved(true);
      onChange(next);
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("people.plan.keyFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="flex flex-col gap-1.5" onSubmit={(event) => void submit(event)}>
      <label htmlFor="people-plan-key" className="text-[12px] font-medium text-ink-secondary">{t("people.plan.keyLabel")}</label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id="people-plan-key"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={t("people.plan.keyPlaceholder")}
          autoComplete="off"
          spellCheck={false}
          disabled={saving}
          className="min-w-0 flex-1 basis-48 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none disabled:opacity-50"
        />
        <button type="submit" disabled={saving || !value.trim()} className="ui-button">{t(saving ? "people.plan.keySaving" : "people.plan.keySave")}</button>
      </div>
      {saved && <p role="status" className="text-[12px] text-ink-secondary">{t("people.plan.keySaved")}</p>}
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </form>
  );
}

/** The 5-person limit and the Premium key, shown above the invite row. Nothing where the server does not set the limit. */
export function PeoplePlan({ plan, onChange }: { plan: PeoplePlanStatus | null; onChange: (plan: PeoplePlanStatus) => void }) {
  if (!plan || !plan.applies) return null;
  const { key } = plan;
  const locked = key?.source === "environment";
  const premium = plan.plan === "premium";
  const unlimited = plan.plan === "unlimited";
  return (
    <div data-people-plan className="mb-3 flex flex-col gap-2">
      {unlimited && <Notice>{t("people.plan.unlimited")}</Notice>}
      {premium && (
        <Notice>
          <span className="font-medium text-ink">{t("people.plan.premium")}</span>
          {key?.endsOn && <span>{t("people.plan.until", { date: planDate(key.endsOn) })}</span>}
        </Notice>
      )}
      {premium && key?.state === "endingSoon" && key.endsOn && (
        <Notice>{t("people.plan.endingSoon", { date: planDate(key.endsOn) })} <PlanLink url={plan.upgradeUrl} label="people.plan.renew" /></Notice>
      )}
      {premium && key?.state === "grace" && key.endsOn && (
        <Notice warning>
          {t("people.plan.grace", { date: planDate(key.endsOn), graceDate: planDate(key.graceEndsOn) })} <PlanLink url={plan.upgradeUrl} label="people.plan.renew" />
        </Notice>
      )}
      {plan.plan === "free" && (
        <>
          <Notice><span className="font-medium text-ink">{t("people.plan.count", { people: String(plan.people), limit: String(plan.limit) })}</span></Notice>
          {key?.state === "ended" && (
            <Notice warning>
              {t("people.plan.ended", { date: planDate(key.endsOn), limit: String(plan.limit) })} <PlanLink url={plan.upgradeUrl} label="people.plan.renew" />
            </Notice>
          )}
          {plan.full && (
            <Notice id="people-plan-full">
              {t("people.plan.full", { limit: String(plan.limit) })} <PlanLink url={plan.upgradeUrl} label="people.plan.upgrade" />
            </Notice>
          )}
        </>
      )}
      {!unlimited && key?.state === "invalid" && !locked && <p className="text-[12px] text-danger">{t("people.plan.keyBroken")}</p>}
      {!unlimited && key?.state === "unreadable" && <p className="text-[12px] text-danger">{t("people.plan.keyUnreadable")}</p>}
      {!unlimited && locked && <p className={cn("text-[12px]", key.state === "invalid" ? "text-danger" : "text-ink-secondary")}>{t(key.state === "invalid" ? "people.plan.keyBrokenLocked" : "people.plan.keyLocked")}</p>}
      {!unlimited && !locked && <KeyField onChange={onChange} />}
    </div>
  );
}
