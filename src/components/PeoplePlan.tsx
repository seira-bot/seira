import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import type { PeoplePlanStatus } from "../../shared/people-plan";

/** A date given as YYYY-MM-DD (UTC), shown as a readable date without shifting the day. */
export function planDate(day: string | undefined): string {
  const time = day ? Date.parse(`${day}T00:00:00Z`) : NaN;
  if (Number.isNaN(time)) return day ?? "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeZone: "UTC" }).format(time);
}

const TEXT_BUTTON = "inline-flex min-h-8 items-center self-start text-[12px] font-medium text-accent hover:underline";
const AMBER_BOX = "rounded-lg border border-warning/25 bg-warning/5 px-3 py-2";

function PlanLink({ url, label }: { url: string; label: "people.plan.upgrade" | "people.plan.renew" }) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-8 items-center gap-1 font-medium text-accent hover:underline">
      {t(label)} <ExternalLink size={12} aria-hidden="true" />
      <span className="sr-only">{t("people.plan.newTab")}</span>
    </a>
  );
}

function Warning({ children }: { children: ReactNode }) {
  return <p className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-relaxed text-ink-secondary ${AMBER_BOX}`}>{children}</p>;
}

function KeyField({ onSaved }: { onSaved: (plan: PeoplePlanStatus) => void }) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const key = value.trim();
    if (!key || saving) return;
    setSaving(true);
    setError(null);
    try {
      const next = (await api("/api/people/plan/key", { method: "PUT", body: JSON.stringify({ key }) })) as PeoplePlanStatus;
      setValue("");
      onSaved(next);
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
          onChange={(event) => { setValue(event.target.value); setError(null); }}
          placeholder={t("people.plan.keyPlaceholder")}
          autoComplete="off"
          spellCheck={false}
          disabled={saving}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "people-plan-key-error" : undefined}
          className={`min-w-0 flex-1 basis-48 rounded-lg border ${error ? "border-danger/60" : "border-hairline/40"} bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none disabled:opacity-50`}
        />
        <button type="submit" disabled={saving || !value.trim()} className="ui-button">{t(saving ? "people.plan.keySaving" : "people.plan.keySave")}</button>
      </div>
      {error && <p id="people-plan-key-error" role="alert" className="text-[12px] text-danger">{error}</p>}
    </form>
  );
}

/** One line above the invite row: the plan and how many people it covers. Nothing where the server does not set the limit. */
export function PeoplePlanSummary({ plan }: { plan: PeoplePlanStatus | null }) {
  if (!plan || !plan.applies) return null;
  const { key } = plan;
  return (
    <p data-people-plan className="mb-3 text-[12px] text-ink-secondary">
      {plan.plan === "unlimited" && t("people.plan.unlimited")}
      {plan.plan === "premium" && (
        <>
          <span className="font-medium text-ink">{t("people.plan.premium")}</span>
          {key?.endsOn && key.state !== "grace" && <> · {t("people.plan.ends", { date: planDate(key.endsOn) })}</>}
        </>
      )}
      {plan.plan === "free" && <span className="font-medium text-ink">{t("people.plan.count", { people: String(plan.people), limit: String(plan.limit) })}</span>}
    </p>
  );
}

/** The reason the Invite button is off. Shown right after the invite row. */
export function PeoplePlanFull({ plan }: { plan: PeoplePlanStatus | null }) {
  if (!plan || !plan.applies || plan.plan !== "free" || !plan.full) return null;
  return (
    <p id="people-plan-full" className={`mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-relaxed text-ink-secondary ${AMBER_BOX}`}>
      {t("people.plan.full", { limit: String(plan.limit) })} <PlanLink url={plan.upgradeUrl} label="people.plan.upgrade" /> {t("people.plan.fullHint")}
    </p>
  );
}

/** The key field starts open when the plan is full or the saved key needs a new one. */
function wantsKey(plan: PeoplePlanStatus | null): boolean {
  if (!plan?.applies) return false;
  if (plan.plan === "free" && plan.full) return true;
  return !!plan.key && ["endingSoon", "grace", "ended", "invalid", "unreadable"].includes(plan.key.state);
}

/** Renewal notices, key problems and the Premium key field. Nothing where the server does not set the limit. */
export function PeoplePlanKey({ plan, onChange }: { plan: PeoplePlanStatus | null; onChange: (plan: PeoplePlanStatus) => void }) {
  const shown = plan?.applies === true ? plan : null;
  const key = shown?.key ?? null;
  const locked = key?.source === "environment";
  const needsKey = wantsKey(shown);
  const [open, setOpen] = useState(needsKey);
  const [status, setStatus] = useState("");
  const focusNext = useRef(false);
  useEffect(() => {
    if (open && focusNext.current) {
      focusNext.current = false;
      document.getElementById("people-plan-key")?.focus();
    }
  }, [open]);
  useEffect(() => {
    if (needsKey) setOpen(true);
  }, [needsKey]);

  if (!shown || shown.plan === "unlimited") return null;
  const reveal = () => { focusNext.current = true; setOpen(true); };
  const toggleProps = { type: "button" as const, className: TEXT_BUTTON, "aria-expanded": false, "aria-controls": "people-plan-key-area", onClick: reveal };
  return (
    <div className="mt-3 flex flex-col gap-2">
      {shown.plan === "premium" && key?.state === "endingSoon" && (
        <Warning>{t("people.plan.endingSoon")} <PlanLink url={shown.upgradeUrl} label="people.plan.renew" /></Warning>
      )}
      {shown.plan === "premium" && key?.state === "grace" && (
        <Warning>{t("people.plan.grace", { date: planDate(key.endsOn), graceDate: planDate(key.graceEndsOn) })} <PlanLink url={shown.upgradeUrl} label="people.plan.renew" /></Warning>
      )}
      {shown.plan === "free" && key?.state === "ended" && (
        <Warning>{t("people.plan.ended", { date: planDate(key.endsOn), limit: String(shown.limit) })} <PlanLink url={shown.upgradeUrl} label="people.plan.renew" /></Warning>
      )}
      {key?.state === "invalid" && !locked && <p className="text-[12px] text-danger">{t("people.plan.keyBroken")}</p>}
      {key?.state === "unreadable" && <p className="text-[12px] text-danger">{t("people.plan.keyUnreadable")}</p>}
      {locked && <p className={`text-[12px] ${key.state === "invalid" ? "text-danger" : "text-ink-secondary"}`}>{t(key.state === "invalid" ? "people.plan.keyBrokenLocked" : "people.plan.keyLocked")}</p>}
      {!locked && (
        <div className="flex flex-col gap-2">
          {!open && shown.plan === "free" && <button {...toggleProps}>{t("people.plan.keyToggle")}</button>}
          {!open && shown.plan === "premium" && (
            <div className="flex flex-wrap items-center gap-x-3">
              {!status && <span className="text-[12px] text-ink-secondary">{t("people.plan.keyCurrent")}</span>}
              <button {...toggleProps}>{t("people.plan.keyReplace")}</button>
            </div>
          )}
          {open && (
            <div id="people-plan-key-area">
              <KeyField onSaved={(next) => { setStatus(t("people.plan.keySaved")); setOpen(wantsKey(next)); onChange(next); }} />
            </div>
          )}
          <p role="status" className="text-[12px] text-ink-secondary">{status}</p>
        </div>
      )}
    </div>
  );
}
