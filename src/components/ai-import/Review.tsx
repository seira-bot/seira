import { t } from "@/lib/i18n";
import type { ImportAgentView, ImportDestination, ImportJobView } from "../../../shared/ai-import/api";
import { Select } from "../Select";
import { Counts } from "./Progress";

export interface BotChoice {
  id: string;
  name: string;
}

export const destinationValue = (destination: ImportDestination) => (destination.kind === "new" ? "new" : `bot:${destination.botId}`);
export const destinationFrom = (value: string): ImportDestination => (value.startsWith("bot:") ? { kind: "bot", botId: value.slice(4) } : { kind: "new" });

export function DestinationSelect({ label, value, bots, onChange }: { label: string; value: ImportDestination; bots: readonly BotChoice[]; onChange: (value: ImportDestination) => void }) {
  return (
    <label className="flex items-center gap-3 text-[13px] leading-5 text-ink-secondary">
      <span className="shrink-0">{label}</span>
      <Select data-ai-import-destination="" aria-label={label} value={destinationValue(value)} onChange={(event) => onChange(destinationFrom(event.target.value))}
        className="min-w-0 flex-1">
        <option value="new">{t("aiImport.dest.new")}</option>
        {bots.map((bot) => <option key={bot.id} value={`bot:${bot.id}`}>{bot.name}</option>)}
      </Select>
    </label>
  );
}

export interface ReviewProps {
  job: ImportJobView;
  bots: readonly BotChoice[];
  /** A choice the person made; the job's own default stands for the rest. */
  choices: Readonly<Record<string, ImportDestination>>;
  busy?: boolean;
  onChoose: (ref: string, destination: ImportDestination) => void;
  onImport: () => void;
  onCancel: () => void;
}

export const chosenDestination = (agent: ImportAgentView, choices: ReviewProps["choices"]): ImportDestination => choices[agent.ref] ?? agent.destination;

/** Reading is over: each bot found, what it holds, where it goes, and one Import button. */
export function ReviewView({ job, bots, choices, busy = false, onChoose, onImport, onCancel }: ReviewProps) {
  const empty = job.agents.length === 0;
  return (
    <div data-ai-import-screen="review" className="flex flex-col gap-4">
      <h3 className="text-[14px] font-medium text-ink">{t("aiImport.review.title")}</h3>
      {empty && <p className="text-[13px] leading-[18px] text-ink-secondary">{t("aiImport.review.nothing")}</p>}
      {job.agents.map((agent) => (
        <section key={agent.ref} data-ai-import-agent={agent.ref} className="flex flex-col gap-2 rounded-xl bg-ink/[0.03] p-3">
          <h4 className="truncate text-[13px] font-medium text-ink" title={agent.name}>{agent.name}</h4>
          <Counts counts={agent.counts} />
          <DestinationSelect label={t("aiImport.review.sendsTo")} value={chosenDestination(agent, choices)} bots={bots} onChange={(destination) => onChoose(agent.ref, destination)} />
        </section>
      ))}
      {job.counts.leftovers > 0 && <p className="text-[12px] leading-4 text-ink-secondary">{t("aiImport.review.unreadable", { count: job.counts.leftovers })}</p>}
      <div className="flex gap-2">
        <button type="button" data-ai-import-apply="" className="ui-button ui-button-primary" disabled={busy || empty} onClick={onImport}>{t("aiImport.import")}</button>
        <button type="button" data-ai-import-cancel="" className="ui-button" disabled={busy} onClick={onCancel}>{t("common.cancel")}</button>
      </div>
    </div>
  );
}
