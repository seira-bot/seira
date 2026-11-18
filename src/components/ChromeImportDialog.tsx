import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { t } from "@/lib/i18n";
import { ApiError } from "@/state/api";
import { api } from "@/state/store";

export interface ImportProfile { id: string; name: string; browserName: string; lastUsed: boolean }
export interface ImportSite { site: string; cookies: number; sensitive: "identity" | "email" | "financial" | null; suggested: boolean }
export interface ImportedSite { site: string; cookies: number; storage: number }
interface SitesAnswer { ticket: string; profileName: string; browserName: string; sites: ImportSite[] }
interface ImportAnswer { imported: { sites: number; cookies: number }; skipped: number; running: boolean; sites: ImportedSite[] }

const BUTTON = "ui-button min-h-9 px-4 text-[14px]";
const PRIMARY = "ui-button ui-button-primary min-h-9 px-4 text-[14px]";
const FOCUSABLE = "button:not([disabled]), input:not([disabled])";

const failure = (cause: unknown) => (cause instanceof Error && cause.message ? cause.message : t("settings.sites.import.error"));

export function ChromeImportDialog({ profiles, target, scope = {}, sharedBy, onImported, onClose }: {
  profiles: readonly ImportProfile[];
  target: { profile: string } | { bot: string };
  scope?: Readonly<Record<string, string>>;
  sharedBy: readonly string[];
  onImported: (sites: ImportedSite[]) => void;
  onClose: () => void;
}) {
  const ordered = [...profiles].sort((a, b) => Number(b.lastUsed) - Number(a.lastUsed));
  const [source, setSource] = useState(ordered[0]!.id);
  const [step, setStep] = useState<"profile" | "sites" | "done">("profile");
  const [found, setFound] = useState<SitesAnswer | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [result, setResult] = useState<ImportAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const titleId = useId();

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = [...dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []];
      if (!controls.length) { event.preventDefault(); dialogRef.current?.focus(); return; }
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (opener?.isConnected && opener !== document.body) opener.focus();
    };
  }, []);

  useEffect(() => {
    const controls = dialogRef.current?.querySelectorAll<HTMLElement>(step === "profile" ? "input:checked" : FOCUSABLE);
    (controls?.[0] ?? dialogRef.current)?.focus();
  }, [step]);

  const profile = ordered.find((entry) => entry.id === source) ?? ordered[0]!;

  const read = async () => {
    setBusy(true);
    setError("");
    try {
      const answer = await api<SitesAnswer>("/api/browser-sites/import/sites", { method: "POST", body: JSON.stringify({ ...target, ...scope, source }) });
      setFound(answer);
      setChosen(new Set(answer.sites.filter((entry) => entry.suggested && !entry.sensitive).map((entry) => entry.site)));
      setStep("sites");
    } catch (cause) { setError(failure(cause)); }
    finally { setBusy(false); }
  };

  const copy = async () => {
    if (!found) return;
    setBusy(true);
    setError("");
    try {
      const answer = await api<ImportAnswer>("/api/browser-sites/import", { method: "POST", body: JSON.stringify({ ...target, ...scope, ticket: found.ticket, sites: found.sites.filter((entry) => chosen.has(entry.site)).map((entry) => entry.site) }) });
      setResult(answer);
      setStep("done");
      onImported(answer.sites);
    } catch (cause) {
      setError(failure(cause));
      if (cause instanceof ApiError && cause.status === 409) setStep("profile");
    } finally { setBusy(false); }
  };

  const toggle = (site: string) => setChosen((current) => {
    const next = new Set(current);
    if (!next.delete(site)) next.add(site);
    return next;
  });

  const count = chosen.size;
  const importLabel = count === 1 ? t("settings.sites.import.countOne") : t("settings.sites.import.count", { count });
  const noneId = `${titleId}-none`;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6" onMouseDown={(event) => event.target === event.currentTarget && close.current()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy} tabIndex={-1} data-look="dialog"
        className="flex max-h-[85vh] w-full max-w-[460px] flex-col gap-3 rounded-2xl border border-hairline/50 bg-panel p-5 shadow-2xl">
        <h2 id={titleId} className="text-[15px] font-semibold text-ink">{t("settings.sites.import.title")}</h2>

        {step === "profile" && (
          <>
            <p className="text-[13px] leading-relaxed text-ink-secondary">{t("settings.sites.import.consent", { browser: profile.browserName })}</p>
            {sharedBy.length > 1 && <p className="text-[12px] leading-relaxed text-ink-secondary">{t("settings.sites.shared", { names: sharedBy.join(", ") })}</p>}
            <fieldset className="flex min-w-0 flex-col gap-1">
              <legend className="sr-only">{t("settings.sites.import.profile")}</legend>
              {ordered.map((entry) => (
                <label key={entry.id} className="flex min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-raised/50">
                  <input type="radio" name={`${titleId}-profile`} checked={entry.id === source} onChange={() => setSource(entry.id)} />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{entry.name}</span>
                  <span className="shrink-0 text-[11px] text-ink-secondary">{entry.browserName}{entry.lastUsed ? ` · ${t("settings.sites.import.lastUsed")}` : ""}</span>
                </label>
              ))}
            </fieldset>
          </>
        )}

        {step === "sites" && found && (
          <>
            <p className="text-[12px] text-ink-secondary">{t("settings.sites.import.sitesFrom", { profile: found.profileName })}</p>
            {found.sites.length === 0 && <p className="text-[13px] text-ink-secondary">{t("settings.sites.import.empty")}</p>}
            {found.sites.length > 0 && (
              <ul className="flex min-h-0 flex-col divide-y divide-hairline/30 overflow-y-auto">
                {found.sites.map((entry) => (
                  <li key={entry.site}>
                    <label className="flex min-w-0 cursor-pointer items-center gap-2 py-1.5">
                      <input type="checkbox" checked={chosen.has(entry.site)} onChange={() => toggle(entry.site)} />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={entry.site}>{entry.site}</span>
                      {entry.sensitive && <span className="shrink-0 rounded-md bg-raised px-1.5 py-0.5 text-[11px] text-ink-secondary">{t(`settings.sites.import.kind.${entry.sensitive}`)}</span>}
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {found.sites.some((entry) => entry.sensitive) && <p className="text-[12px] text-ink-secondary">{t("settings.sites.import.sensitive")}</p>}
            {count === 0 && <p id={noneId} className="text-[12px] text-ink-secondary">{t("settings.sites.import.none")}</p>}
          </>
        )}

        {step === "done" && result && (
          <div role="status" className="flex flex-col gap-1 text-[13px] text-ink">
            <p>{result.imported.sites === 1 ? t("settings.sites.import.doneOne", { cookies: result.imported.cookies }) : t("settings.sites.import.done", { sites: result.imported.sites, cookies: result.imported.cookies })}</p>
            {result.skipped > 0 && <p className="text-ink-secondary">{t("settings.sites.import.skipped", { skipped: result.skipped })}</p>}
          </div>
        )}

        {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}

        <div className="mt-2 flex justify-end gap-2">
          {step === "profile" && (
            <>
              <button type="button" className={BUTTON} onClick={onClose}>{t("common.cancel")}</button>
              <button type="button" className={PRIMARY} disabled={busy} onClick={() => void read()}>{busy ? t("settings.sites.import.working") : t("settings.sites.import.continue")}</button>
            </>
          )}
          {step === "sites" && (
            <>
              <button type="button" className={BUTTON} disabled={busy} onClick={() => { setError(""); setStep("profile"); }}>{t("settings.sites.import.back")}</button>
              <button type="button" className={BUTTON} onClick={onClose}>{t("common.cancel")}</button>
              <button type="button" className={PRIMARY} disabled={busy || count === 0} aria-describedby={count === 0 ? noneId : undefined} onClick={() => void copy()}>{busy ? t("settings.sites.import.working") : importLabel}</button>
            </>
          )}
          {step === "done" && <button type="button" className={PRIMARY} onClick={onClose}>{t("common.close")}</button>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
