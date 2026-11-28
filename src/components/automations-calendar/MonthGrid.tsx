import { Check, X } from "lucide-react";

import type { CalendarAutomation } from "@/lib/automation-calendar";
import { cn } from "@/lib/cn";
import { intlLocale, t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { emphasisClass, StepAvatars, type Emphasis } from "./OccurrenceCard";
import { AppMark } from "./RunChip";
import { clock, longDay, occurrenceLabel, schedulePhrase } from "./phrases";
import { shownMonth, type ShownOccurrence } from "./model";

const BAND_TOP = 31;
const BAND_STEP = 25;
const WEEKS = 6;

type Month = ReturnType<typeof shownMonth>;

function chipLook(occurrence: ShownOccurrence) {
  if (occurrence.paused) return "border-dashed border-hairline bg-transparent text-ink-tertiary";
  if (occurrence.kind === "scheduled") return occurrence.needsYou ? "border-warning/60 bg-warning/10 text-ink" : "border-accent/40 bg-accent/15 text-ink";
  return cn("border-hairline/50 bg-inset text-ink-secondary", (occurrence.runStatus === "failed" || occurrence.kind === "missed") && "border-danger/70");
}

/** Six weeks. A schedule that runs every day is one band per week; a busy day folds into "+ N more". */
export function MonthGrid({ month, automations, bots, emphasisOf, selectedKey, siblingOf, onOpen, onOpenBand, onPickDay }: {
  month: Month;
  automations: ReadonlyMap<string, CalendarAutomation>;
  bots: readonly Bot[];
  emphasisOf: (automationId: string) => Emphasis;
  selectedKey: string | null;
  siblingOf: (occurrence: ShownOccurrence) => boolean;
  onOpen: (occurrence: ShownOccurrence) => void;
  onOpenBand: (automationId: string, startId: string) => void;
  onPickDay: (day: number) => void;
}) {
  const weekdays = Array.from({ length: 7 }, (_, index) => new Date(2026, 10, 23 + index).toLocaleDateString(intlLocale(), { weekday: "short" }));
  return (
    <div className="flex min-w-0 flex-1 flex-col" data-month-grid="">
      <div className="grid h-8 shrink-0 grid-cols-7 border-b border-hairline/40">
        {weekdays.map((name) => <div key={name} className="flex items-center border-l border-hairline/40 px-2.5 text-[12px] text-ink-tertiary">{name}</div>)}
      </div>
      <div className="grid min-h-0 flex-1 overflow-auto" style={{ gridTemplateRows: `repeat(${WEEKS}, minmax(96px, 1fr))` }}>
        {Array.from({ length: WEEKS }, (_, week) => {
          const bands = month.bands.filter((band) => band.week === week);
          const spacerFor = (column: number) => bands.reduce((rows, band, index) => (band.fromColumn <= column && column <= band.toColumn ? index + 1 : rows), 0);
          return (
            <div key={week} data-month-week={week} className="relative grid min-h-0 grid-cols-7 border-b border-hairline/40">
              {month.cells.slice(week * 7, week * 7 + 7).map((cell, column) => (
                <div key={cell.day} data-month-day={cell.day} data-today={cell.today ? "" : undefined} data-in-month={cell.inMonth ? "" : undefined} className="flex min-w-0 flex-col gap-[3px] overflow-hidden border-l border-hairline/40 px-[5px] py-1">
                  <button type="button" onClick={() => onPickDay(cell.day)} aria-label={longDay(cell.day)} title={longDay(cell.day)}
                    className={cn("inline-flex h-6 min-w-6 flex-none items-center justify-center self-start rounded-full px-[5px] text-[12px] font-semibold hover:bg-raised", cell.today ? "bg-accent text-accent-ink hover:bg-accent" : cell.inMonth ? "text-ink" : "font-medium text-ink-tertiary")}>
                    {new Date(cell.day).getDate()}
                  </button>
                  {spacerFor(column) > 0 && <div aria-hidden="true" className="flex-none" style={{ height: spacerFor(column) * BAND_STEP - 3 }} />}
                  {cell.chips.map((chip) => {
                    const automation = automations.get(chip.automationId);
                    const name = automation?.name ?? "";
                    const label = occurrenceLabel(chip, name);
                    return (
                      <button key={chip.key} type="button" data-occurrence={chip.key} data-kind={chip.kind} data-automation-id={chip.automationId} data-run-status={chip.runStatus}
                        data-selected={selectedKey === chip.key ? "" : undefined} data-sibling={siblingOf(chip) ? "" : undefined} data-highlight={emphasisOf(chip.automationId) ?? undefined} data-paused={chip.paused ? "" : undefined}
                        aria-label={label} title={label} onClick={() => onOpen(chip)}
                        className={cn("flex h-[22px] w-full flex-none items-center gap-[5px] overflow-hidden whitespace-nowrap rounded-md border px-1.5 text-left text-[12px] leading-4", chipLook(chip), siblingOf(chip) && "border-accent", selectedKey === chip.key && "outline outline-2 outline-offset-1 outline-accent", emphasisClass(emphasisOf(chip.automationId)))}>
                        {chip.kind === "app-run" && <AppMark start={automation?.starts.find((start) => start.id === chip.startId)} />}
                        {chip.runStatus === "done" && <Check size={12} aria-hidden="true" className="shrink-0 text-success" />}
                        {(chip.runStatus === "failed") && <X size={12} aria-hidden="true" className="shrink-0 text-danger" />}
                        {chip.kind === "missed" && <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-danger" />}
                        {chip.kind === "scheduled" && <StepAvatars botIds={automation?.stepBotIds.slice(0, 1) ?? []} bots={bots} />}
                        <span className="shrink-0 tabular-nums text-ink-secondary">{clock(chip.at)}</span>
                        <span className="min-w-0 truncate">{name}</span>
                      </button>
                    );
                  })}
                  {cell.more > 0 && <button type="button" data-more="" onClick={() => onPickDay(cell.day)} className="flex h-[22px] w-full flex-none items-center rounded-md px-1 text-left text-[12px] font-medium leading-4 text-ink-secondary hover:bg-raised hover:text-ink">{t("automations.cal.more", { count: cell.more })}</button>}
                </div>
              ))}
              {bands.map((band, index) => {
                const automation = automations.get(band.automationId);
                const start = automation?.starts.find((candidate) => candidate.id === band.startId);
                const time = start?.kind === "schedule" && start.schedule.type === "daily" ? start.schedule.time : "";
                const label = `${automation?.name ?? ""}, ${schedulePhrase({ days: "all", time })}`;
                return (
                  <button key={band.key} type="button" data-band={band.key} data-paused={band.paused ? "" : undefined} data-automation-id={band.automationId} data-highlight={emphasisOf(band.automationId) ?? undefined}
                    aria-label={label} title={label} onClick={() => onOpenBand(band.automationId, band.startId)}
                    className={cn("absolute z-[2] flex h-[22px] items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-md border px-2 text-left text-[12px] leading-4",
                      band.paused ? "border-dashed border-hairline bg-transparent text-ink-tertiary" : "border-accent/40 bg-accent/15 text-ink", emphasisClass(emphasisOf(band.automationId)))}
                    style={{ left: `calc(${(band.fromColumn / 7) * 100}% + 4px)`, width: `calc(${((band.toColumn - band.fromColumn + 1) / 7) * 100}% - 8px)`, top: BAND_TOP + index * BAND_STEP }}>
                    <StepAvatars botIds={automation?.stepBotIds.slice(0, 1) ?? []} bots={bots} />
                    <span className="shrink-0 tabular-nums text-ink-secondary">{time}</span>
                    <span className="min-w-0 truncate">{automation?.name}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
