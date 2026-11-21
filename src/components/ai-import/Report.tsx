import { t, activeLocale } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { ImportJobView, ImportNextSteps } from "../../../shared/ai-import/api";
import { kindText, reasonText } from "./copy";
import { ImportError } from "./Errors";

export interface ReportProps {
  job: ImportJobView;
  undoing?: boolean;
  undoFailed?: boolean;
  onUndo: () => void;
  onDone: () => void;
  onRetry: () => void;
}

function NextSteps({ next }: { next: ImportNextSteps }) {
  const groups = [
    { key: "addKey", items: next.addKey.map((item) => t("aiImport.next.addKeyItem", { bot: item.botName, tool: item.tool })) },
    { key: "allowSkill", items: next.allowSkill.map((item) => t("aiImport.next.allowSkillItem", { bot: item.botName, skill: item.skill })) },
    { key: "connectAgain", items: next.connectAgain.map((item) => t("aiImport.next.connectAgainItem", { bot: item.botName, channel: item.channel })) },
    { key: "resumeRoutine", items: next.resumeRoutine.map((item) => t("aiImport.next.resumeRoutineItem", { bot: item.botName, routine: item.routine })) },
  ].filter((group) => group.items.length > 0);
  if (groups.length === 0) return null;
  return (
    <section data-ai-import-next="" className="flex flex-col gap-2">
      <h4 className="text-[13px] font-medium text-ink">{t("aiImport.next.title")}</h4>
      {groups.map((group) => (
        <div key={group.key} data-ai-import-step={group.key} className="flex flex-col gap-0.5">
          <span className="text-[12px] font-medium leading-4 text-ink-secondary">{t(`aiImport.next.${group.key}` as LocaleKey)}</span>
          <ul className="flex flex-col gap-0.5 text-[13px] leading-[18px] text-ink">{group.items.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}</ul>
        </div>
      ))}
    </section>
  );
}

/** The end of a job: what came in, what did not and why, what is left for the person, and Undo. */
export function ReportView({ job, undoing = false, undoFailed = false, onUndo, onDone, onRetry }: ReportProps) {
  if (job.state === "failed" && job.error) return <ImportError code={job.error} onBack={onDone} />;
  const report = job.report;
  const canUndo = job.undoUntil !== null && job.state !== "undone" && report !== null;
  const rows = report ? [
    { key: "added", label: t("aiImport.report.added"), value: report.added },
    { key: "updated", label: t("aiImport.report.updated"), value: report.updated },
    { key: "keptBoth", label: t("aiImport.report.keptBoth"), value: report.keptBoth },
    { key: "notBrought", label: t("aiImport.report.notBrought"), value: report.leftovers.length },
  ] : [];
  return (
    <div data-ai-import-screen="report" data-ai-import-state={job.state} className="flex flex-col gap-4">
      <h3 className="text-[14px] font-medium text-ink">{t(`aiImport.report.title.${job.state === "queued" || job.state === "reading" || job.state === "ready" || job.state === "applying" ? "done" : job.state}` as LocaleKey)}</h3>
      {job.state === "failed" && <p role="alert" className="text-[13px] leading-[18px] text-ink-secondary">{t("aiImport.report.failed")}</p>}
      {report && (
        <dl data-ai-import-totals="" className="flex flex-col gap-1 text-[13px] leading-[18px]">
          {rows.map((row) => (
            <div key={row.key} data-ai-import-total={row.key} className="flex items-baseline justify-between gap-4">
              <dt className="text-ink-secondary">{row.label}</dt>
              <dd className="tabular-nums text-ink">{row.value.toLocaleString()}</dd>
            </div>
          ))}
        </dl>
      )}
      {report && report.leftovers.length > 0 && (
        <details data-ai-import-leftovers="" className="text-[13px] leading-[18px]">
          <summary className="cursor-pointer text-ink-secondary">{t("aiImport.report.notBroughtList", { count: report.leftovers.length })}</summary>
          <ul className="mt-1 flex flex-col gap-0.5 text-ink">
            {report.leftovers.map((item) => (
              <li key={`${item.kind}-${item.ref}`} className="break-words">{t("aiImport.report.item", { what: item.name ? `${kindText(item.kind)} ${item.name}` : kindText(item.kind), reason: reasonText(item.reason) })}</li>
            ))}
          </ul>
        </details>
      )}
      {report && <NextSteps next={report.next} />}
      {job.undoResult && (
        <div role="status" data-ai-import-undone="" className="flex flex-col gap-1 text-[13px] leading-[18px] text-ink-secondary">
          <p>{t("aiImport.undo.result", { removed: job.undoResult.removed, restored: job.undoResult.restored })}</p>
          {job.undoResult.kept.length > 0 && (
            <>
              <p>{t("aiImport.undo.kept")}</p>
              <ul className="text-ink">{job.undoResult.kept.map((name) => <li key={name} className="break-words">{name}</li>)}</ul>
            </>
          )}
        </div>
      )}
      {undoFailed && <p role="alert" className="text-[12px] leading-4 text-danger">{t("aiImport.undo.failed")}</p>}
      {canUndo && job.undoUntil !== null && <p className="text-[12px] leading-4 text-ink-tertiary">{t("aiImport.undo.until", { date: new Date(job.undoUntil).toLocaleDateString(activeLocale()) })}</p>}
      <div className="flex gap-2">
        {job.state === "failed" && <button type="button" data-ai-import-retry="" className="ui-button ui-button-primary" onClick={onRetry}>{t("common.tryAgain")}</button>}
        {canUndo && <button type="button" data-ai-import-undo="" className="ui-button" disabled={undoing} onClick={onUndo}>{t("common.undo")}</button>}
        <button type="button" data-ai-import-done="" className={job.state === "failed" ? "ui-button" : "ui-button ui-button-primary"} onClick={onDone}>{t("common.done")}</button>
      </div>
    </div>
  );
}
