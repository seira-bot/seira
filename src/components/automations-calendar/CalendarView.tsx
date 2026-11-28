import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";

import { gridHours, type CalendarAutomation } from "@/lib/automation-calendar";
import { cn } from "@/lib/cn";
import { intlLocale, t } from "@/lib/i18n";
import { resetMarkers, type EngineLimit } from "@/lib/limit-resets";
import type { RoutineSchedule } from "@/lib/routines";
import { addDays, calendarRangeLabel, startOfDay, startOfWeek } from "@/lib/routine-calendar";
import { useRoutineRunsFrom } from "@/state/older-routine-runs";
import type { Bot } from "@/state/store";
import { SeiraCharacter } from "../seira-character";
import { CalendarRail } from "./CalendarRail";
import { MonthGrid } from "./MonthGrid";
import { MoveToast } from "./MoveToast";
import { TimeGrid } from "./TimeGrid";
import { shownMonth, shownOccurrences, type ShownOccurrence } from "./model";
import { useCalendarMove } from "./useCalendarMove";

export type CalendarRange = "day" | "week" | "month";
export interface OpenedOccurrence { at: number; runId?: string }

const TICK_MS = 60_000;
const NARROW = 640;

const runIdOf = (automation: CalendarAutomation | undefined, occurrence: ShownOccurrence) => automation?.runs.find((run) => run.routineId === occurrence.startId
  && (run.scheduledFor === occurrence.at || (run.startedAt ?? run.scheduledFor ?? run.createdAt) === occurrence.at))?.id;

/** The Automations calendar: the rail of automations, then Day, Week or Month. The page gives it the automations; it only asks for older runs when the range reaches before the loaded ones. */
export function CalendarView({ automations, bots, engines, advanced, selectedId, busyId, now: fixedNow, onOpen, onNew, onToggle, saveSchedule }: {
  automations: readonly CalendarAutomation[];
  bots: readonly Bot[];
  engines: readonly EngineLimit[];
  advanced: boolean;
  /** The automation whose panel is open. */
  selectedId: string | null;
  busyId?: string | null;
  now?: number;
  onOpen: (automationId: string, startId: string, occurrence?: OpenedOccurrence) => void;
  onNew: (slotAt?: number) => void;
  onToggle: (automation: CalendarAutomation) => void;
  saveSchedule: (startId: string, schedule: RoutineSchedule) => Promise<void>;
}) {
  const [clockNow, setClockNow] = useState(() => Date.now());
  const now = fixedNow ?? clockNow;
  const [range, setRange] = useState<CalendarRange>(() => (window.innerWidth < NARROW ? "day" : "week"));
  const [anchor, setAnchor] = useState(() => startOfDay(fixedNow ?? Date.now()));
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ key: string; automationId: string } | null>(null);
  useEffect(() => {
    if (fixedNow !== undefined) return;
    const timer = window.setInterval(() => setClockNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [fixedNow]);

  useEffect(() => { setPicked((current) => (current && current.automationId !== selectedId ? null : current)); }, [selectedId]);

  const byId = useMemo(() => new Map(automations.map((automation) => [automation.id, automation])), [automations]);
  const days = useMemo(() => {
    if (range === "day") return [anchor];
    const first = startOfWeek(anchor);
    return Array.from({ length: 7 }, (_, index) => addDays(first, index));
  }, [range, anchor]);
  const last = days.at(-1)!;
  const rangeStart = range === "month" ? startOfWeek(new Date(new Date(anchor).getFullYear(), new Date(anchor).getMonth(), 1).getTime()) : days[0]!;
  useRoutineRunsFrom(rangeStart);
  const occurrences = useMemo(() => (range === "month" ? [] : shownOccurrences(automations, days[0]!, addDays(last, 1), now)), [range, automations, days, last, now]);
  const resets = useMemo(() => (advanced && range !== "month" ? resetMarkers(engines, days[0]!, addDays(last, 1), now) : []), [advanced, engines, range, days, last, now]);
  const hours = useMemo(() => gridHours(occurrences, resets.map((mark) => mark.at)), [occurrences, resets]);
  const month = useMemo(() => (range === "month" ? shownMonth(automations, anchor, now) : null), [range, automations, anchor, now]);

  const move = useCalendarMove({
    find: (occurrence) => {
      const start = byId.get(occurrence.automationId)?.starts.find((candidate) => candidate.id === occurrence.startId);
      return start?.kind === "schedule" ? { name: byId.get(occurrence.automationId)!.name, schedule: start.schedule } : null;
    },
    save: saveSchedule,
    now,
  });

  const activePick = selectedId !== null ? picked : null;
  const emphasisOf = (automationId: string) => (hoverId === null ? null : hoverId === automationId ? "on" as const : "dim" as const);
  const siblingOf = (occurrence: ShownOccurrence) => !!activePick && occurrence.multi && occurrence.automationId === activePick.automationId && occurrence.key !== activePick.key;
  const open = (occurrence: ShownOccurrence) => {
    setPicked({ key: occurrence.key, automationId: occurrence.automationId });
    const runId = occurrence.kind === "past-run" || occurrence.kind === "app-run" ? runIdOf(byId.get(occurrence.automationId), occurrence) : undefined;
    onOpen(occurrence.automationId, occurrence.startId, { at: occurrence.at, ...(runId ? { runId } : {}) });
  };

  const step = (direction: 1 | -1) => setAnchor((current) => {
    if (range === "month") return new Date(new Date(current).getFullYear(), new Date(current).getMonth() + direction, 1).getTime();
    return addDays(current, direction * (range === "week" ? 7 : 1));
  });
  const title = range === "month"
    ? new Date(anchor).toLocaleDateString(intlLocale(), { month: "long", year: "numeric" })
    : calendarRangeLabel(days[0]!, days.length);
  const noSchedule = !automations.some((automation) => automation.starts.some((start) => start.kind === "schedule"));
  const iconButton = "inline-flex size-8 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink";

  return (
    <div data-automations-calendar="" className="flex min-h-0 min-w-0 flex-1">
      <CalendarRail automations={automations} selectedId={selectedId} busyId={busyId} onHover={setHoverId}
        onOpen={(automation) => { setPicked(null); onOpen(automation.id, automation.starts[0]?.id ?? automation.id); }} onToggle={onToggle} />
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-auto min-h-[52px] shrink-0 flex-wrap items-center gap-1.5 border-b border-hairline/40 bg-app px-3 py-1.5 sm:px-4">
          <button type="button" onClick={() => setAnchor(startOfDay(now))} className="h-8 rounded-lg border border-hairline/50 px-3 text-[13px] font-medium text-ink hover:bg-raised">{t("routines.today")}</button>
          <button type="button" aria-label={t("routines.previous")} onClick={() => step(-1)} className={iconButton}><ChevronLeft size={16} aria-hidden="true" /></button>
          <button type="button" aria-label={t("routines.next")} onClick={() => step(1)} className={iconButton}><ChevronRight size={16} aria-hidden="true" /></button>
          <h2 data-range-title="" className="ml-1.5 whitespace-nowrap text-[15px] font-semibold leading-5 text-ink">{title}</h2>
          <div role="group" aria-label={t("automations.cal.view.label")} className="ml-auto flex items-center gap-0.5 rounded-lg border border-hairline/50 bg-panel p-0.5">
            {(["day", "week", "month"] as const).map((option) => (
              <button key={option} type="button" data-range={option} aria-pressed={range === option} onClick={() => setRange(option)}
                className={cn("h-7 rounded-md px-3 text-[13px] font-medium", range === option ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink")}>
                {t(option === "day" ? "routines.view.day" : option === "week" ? "routines.view.week" : "automations.cal.view.month")}
              </button>
            ))}
          </div>
        </div>
        {month ? (
          <MonthGrid month={month} automations={byId} bots={bots} emphasisOf={emphasisOf} selectedKey={activePick?.key ?? null} siblingOf={siblingOf} onOpen={open}
            onOpenBand={(automationId, startId) => { setPicked(null); onOpen(automationId, startId); }}
            onPickDay={(day) => { setRange("day"); setAnchor(day); }} />
        ) : (
          <TimeGrid days={days} occurrences={occurrences} automations={byId} bots={bots} hours={hours} now={now} resets={resets} emphasisOf={emphasisOf}
            selectedKey={activePick?.key ?? null} siblingOf={siblingOf} move={move} onOpen={open} onSlot={onNew} />
        )}
        {noSchedule && (
          <div data-calendar-empty="" className="pointer-events-none absolute inset-x-0 bottom-0 top-[52px] z-[5] flex flex-col items-center justify-center gap-3">
            <SeiraCharacter state="sleep" size={96} />
            <p className="text-[15px] font-medium leading-5 text-ink">{t("automations.cal.empty")}</p>
            <button type="button" onClick={() => onNew()} className="pointer-events-auto inline-flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-[13px] font-medium text-accent-ink hover:brightness-110"><Plus size={15} aria-hidden="true" />{t("automations.cal.emptyNew")}</button>
          </div>
        )}
        {move.toast && <MoveToast toast={move.toast} onDismiss={move.dismiss} />}
      </div>
    </div>
  );
}
