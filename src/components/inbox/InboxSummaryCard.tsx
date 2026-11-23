import type { InboxRow, InboxView } from "../../../shared/inbox";
import { t } from "@/lib/i18n";
import { doneInboxRows, hideInboxSummary } from "@/state/inbox";
import { isDecision, isNews } from "./inbox-kind";

const linkCls = "rounded-md px-1 py-0.5 text-[12px] text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

const newest = (rows: InboxRow[]): InboxRow | undefined => [...rows].sort((a, b) => b.at - a.at)[0];

/** One summary of the news at the top of the Inbox. What needs a decision comes from the rows themselves; the sentences
 * about the news are the writer's, one for each conversation. */
export function InboxSummaryCard({ view, onOpen }: { view: InboxView; onOpen(row: InboxRow): void }) {
  const summary = view.summary;
  if (!summary) return null;
  const covered = new Set(summary.covers);
  const byId = new Map(view.rows.map((row) => [row.id, row]));
  const decisions = view.rows.filter((row) => covered.has(row.id) && isDecision(row)).sort((a, b) => b.at - a.at);
  const open = view.rows.filter((row) => covered.has(row.id) && isNews(row));
  const items = summary.items.map((item) => ({ item, rows: item.rowIds.map((id) => byId.get(id)).filter((row): row is InboxRow => row !== undefined && isNews(row)) })).filter(({ rows }) => rows.length > 0);
  const worth = items.filter(({ item }) => item.important);
  const more = items.filter(({ item }) => !item.important);
  return (
    <section data-inbox-summary={summary.id} aria-label={t("inbox.summary.title")} className="mx-3 mb-2 space-y-2 rounded-xl p-3 ring-1 ring-inset ring-ink/[0.07]">
      <div>
        <h3 className="text-[13px] font-medium text-ink">{t("inbox.summary.title")}</h3>
        <p data-inbox-summary-by className="text-[12px] italic text-ink-tertiary">{t("inbox.summary.by", { name: summary.by.name, count: summary.covers.length })}</p>
      </div>
      {decisions.length > 0 && (
        <div data-inbox-summary-decisions className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">{t("inbox.summary.decisions")}</p>
          <ul className="space-y-px">
            {decisions.map((row) => (
              <li key={row.id}>
                <button type="button" data-inbox-summary-decision={row.id} onClick={() => onOpen(row)}
                  className="block w-full min-w-0 rounded-lg px-2 py-1.5 text-left text-[12px] hover:bg-raised/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60">
                  <span className="block truncate font-medium text-ink">{row.origin?.title ?? row.from.name}</span>
                  <span className="line-clamp-2 text-ink-secondary">{row.text}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {worth.length > 0 && (
        <div data-inbox-summary-worth className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">{t("inbox.summary.worth")}</p>
          <ul className="space-y-px">
            {worth.map(({ item, rows }) => (
              <li key={item.threadId}>
                <button type="button" data-inbox-summary-item={item.threadId} onClick={() => { const row = newest(rows); if (row) onOpen(row); }}
                  className="block w-full min-w-0 rounded-lg px-2 py-1.5 text-left text-[12px] hover:bg-raised/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60">
                  <span className="block truncate font-medium text-ink">{item.title}</span>
                  <span className="text-ink-secondary">{item.text}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {more.length > 0 && (
        <details data-inbox-summary-more className="text-[12px]">
          <summary className="cursor-pointer rounded-md px-1 py-0.5 text-ink-secondary hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">{t("inbox.summary.more", { count: more.length })}</summary>
          <ul className="mt-1 space-y-px">
            {more.map(({ item, rows }) => (
              <li key={item.threadId}>
                <button type="button" data-inbox-summary-item={item.threadId} onClick={() => { const row = newest(rows); if (row) onOpen(row); }}
                  className="block w-full min-w-0 rounded-lg px-2 py-1.5 text-left hover:bg-raised/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60">
                  <span className="block truncate font-medium text-ink">{item.title}</span>
                  <span className="text-ink-secondary">{item.text}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {open.length > 0 && (
          <button type="button" data-inbox-summary-done onClick={() => doneInboxRows(open)} className="ui-button ui-button-md ui-button-pill ui-button-primary">{t("common.done")}</button>
        )}
        <button type="button" data-inbox-summary-hide onClick={() => void hideInboxSummary(false)} className={linkCls}>{t("inbox.summary.hide")}</button>
        <button type="button" data-inbox-summary-wrong onClick={() => void hideInboxSummary(true)} className={linkCls}>{t("inbox.summary.wrong")}</button>
      </div>
    </section>
  );
}
