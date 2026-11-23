import { Loader2 } from "lucide-react";

import { t } from "@/lib/i18n";
import type { ImportJobView } from "../../../shared/ai-import/api";
import { shownCounts, sourceName } from "./copy";

export function Counts({ counts }: { counts: ImportJobView["counts"] }) {
  const rows = shownCounts(counts);
  if (rows.length === 0) return null;
  return (
    <dl data-ai-import-counts="" className="flex flex-col gap-1 text-[13px] leading-[18px]">
      {rows.map(({ key, label, value }) => (
        <div key={key} className="flex items-baseline justify-between gap-4">
          <dt className="text-ink-secondary">{label}</dt>
          <dd className="tabular-nums text-ink">{value.toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}

function Bar({ progress }: { progress: ImportJobView["progress"] }) {
  if (progress.total === null || progress.total <= 0) return null;
  const percent = Math.min(100, Math.round((progress.done / progress.total) * 100));
  return (
    <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1 w-full overflow-hidden rounded-full bg-ink/[0.08]">
      <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
    </div>
  );
}

/** Reading: the counts grow as the file is read. */
export function ReadingView({ job, onCancel }: { job: ImportJobView; onCancel: () => void }) {
  const title = job.state === "queued" ? t("aiImport.reading.queued")
    : job.source.kind === "paste" || job.source.name === undefined ? t("aiImport.reading.title")
      : t("aiImport.reading.local", { source: job.source.name || sourceName(job.source.kind) });
  return (
    <div data-ai-import-screen="reading" role="status" className="flex flex-col gap-3">
      <h3 className="flex items-center gap-2 text-[14px] font-medium text-ink"><Loader2 size={14} className="animate-spin" aria-hidden="true" />{title}</h3>
      <Bar progress={job.progress} />
      <Counts counts={job.counts} />
      <div><button type="button" data-ai-import-cancel="" className="ui-button" onClick={onCancel}>{t("common.cancel")}</button></div>
    </div>
  );
}

/** Applying: bots are ready first, chats follow. Stop keeps the finished batches. */
export function ApplyView({ job, onStop }: { job: ImportJobView; onStop: () => void }) {
  return (
    <div data-ai-import-screen="applying" role="status" className="flex flex-col gap-3">
      <h3 className="flex items-center gap-2 text-[14px] font-medium text-ink"><Loader2 size={14} className="animate-spin" aria-hidden="true" />{t("aiImport.apply.title")}</h3>
      <p className="text-[13px] leading-[18px] text-ink-secondary">{t("aiImport.apply.line")}</p>
      <Bar progress={job.progress} />
      <Counts counts={job.counts} />
      <div><button type="button" data-ai-import-stop="" className="ui-button" onClick={onStop}>{t("aiImport.apply.stop")}</button></div>
    </div>
  );
}
