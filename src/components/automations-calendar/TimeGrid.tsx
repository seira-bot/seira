import { Plus, RotateCcw } from "lucide-react";

import type { CalendarAutomation, GridHours } from "@/lib/automation-calendar";
import { GRID_FIRST_HOUR, GRID_LAST_HOUR } from "@/lib/automation-calendar";
import { cn } from "@/lib/cn";
import { intlLocale, t } from "@/lib/i18n";
import type { ResetMarker } from "@/lib/limit-resets";
import { addDays, atLocalTime } from "@/lib/routine-calendar";
import type { Bot } from "@/state/store";
import { CARD_HEIGHT, OccurrenceCard, type CardLook, type Emphasis } from "./OccurrenceCard";
import { CHIP_HEIGHT, RunChip } from "./RunChip";
import { clock, longDay } from "./phrases";
import { layLanes, type ShownOccurrence } from "./model";
import type { MoveDrag } from "./useCalendarMove";

export const HOUR_HEIGHT = 40;
const GUTTER = 56;
const DAY_CARD_WIDTH = 560;
const HOUR_MS = 3_600_000;

export interface GridMove {
  drag: MoveDrag | null;
  begin: (occurrence: ShownOccurrence, event: React.PointerEvent) => void;
  consumeClick: () => boolean;
}

const hourOf = (at: number) => new Date(at).getHours() + new Date(at).getMinutes() / 60;

/** Day or Week: 40 px per hour, a row that folds the empty hours before and after, a line for now. */
export function TimeGrid({ days, occurrences, automations, bots, hours, now, resets, emphasisOf, selectedKey, siblingOf, move, onOpen, onSlot }: {
  days: readonly number[];
  occurrences: readonly ShownOccurrence[];
  automations: ReadonlyMap<string, CalendarAutomation>;
  bots: readonly Bot[];
  hours: GridHours;
  now: number;
  resets: readonly ResetMarker[];
  emphasisOf: (automationId: string) => Emphasis;
  selectedKey: string | null;
  siblingOf: (occurrence: ShownOccurrence) => boolean;
  move: GridMove;
  onOpen: (occurrence: ShownOccurrence) => void;
  onSlot: (at: number) => void;
}) {
  const oneColumn = days.length === 1;
  const rows = Array.from({ length: hours.end - hours.start }, (_, index) => hours.start + index);
  const height = rows.length * HOUR_HEIGHT;
  const topOf = (at: number) => (hourOf(at) - hours.start) * HOUR_HEIGHT;
  const columns = { gridTemplateColumns: `${GUTTER}px repeat(${days.length}, minmax(0, 1fr))` };
  const today = days.find((day) => now >= day && now < addDays(day, 1));
  const dayName = (day: number) => new Date(day).toLocaleDateString(intlLocale(), { weekday: "short" });

  const note = (text: string, edge: "top" | "bottom") => (
    <div data-fold={edge} className={cn("grid h-6 items-center text-[12px] text-ink-tertiary", edge === "top" ? "border-b" : "border-t", "border-dashed border-hairline/50")} style={{ gridTemplateColumns: `${GUTTER}px minmax(0, 1fr)` }}>
      <span /><span className="pl-2.5">{text}</span>
    </div>
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-time-grid={oneColumn ? "day" : "week"}>
      <div className="grid h-11 shrink-0 border-b border-hairline/40" style={columns}>
        <span />
        {days.map((day) => (
          <div key={day} data-day-head={day} className={cn("flex items-center gap-1.5 border-l border-hairline/40 text-[12px] text-ink-secondary", oneColumn ? "justify-start pl-4" : "justify-center", day === today && "font-medium text-accent-text")}>
            {dayName(day)}
            <b className={cn("inline-flex h-[26px] min-w-[26px] items-center justify-center rounded-full px-1 text-[13px] font-semibold", day === today ? "bg-accent text-accent-ink" : "text-ink")}>{new Date(day).getDate()}</b>
          </div>
        ))}
      </div>
      <div className={cn("min-h-0 flex-1 overflow-auto select-none", move.drag && "[&_[data-occurrence]]:pointer-events-none")} data-cal-scroll="">
        {hours.before && note(t("automations.cal.before", { time: `${String(GRID_FIRST_HOUR).padStart(2, "0")}:00` }), "top")}
        <div className="grid" style={columns}>
          <div className="relative" style={{ height }} data-hour-column="">
            {rows.map((hour, index) => <span key={hour} className="absolute right-2 text-[12px] leading-4 tabular-nums text-ink-tertiary" style={{ top: index === 0 ? 0 : index * HOUR_HEIGHT - 8 }}>{String(hour).padStart(2, "0")}:00</span>)}
            {resets.filter((mark) => mark.at >= atLocalTime(days[0]!, "00:00") && mark.at < addDays(days.at(-1)!, 1) && hourOf(mark.at) >= hours.start && hourOf(mark.at) < hours.end).map((mark) => (
              <span key={`${mark.engine}:${mark.at}`} data-reset-mark={mark.engine} title={t("automations.cal.resetMark", { engine: mark.name, time: clock(mark.at) })} aria-label={t("automations.cal.resetMark", { engine: mark.name, time: clock(mark.at) })} role="img"
                className="absolute left-1 flex size-4 items-center justify-center rounded text-ink-tertiary" style={{ top: topOf(mark.at) - 8 }}>
                <RotateCcw size={12} aria-hidden="true" />
              </span>
            ))}
          </div>
          {days.map((day) => {
            const mine = occurrences.filter((occurrence) => occurrence.at >= day && occurrence.at < addDays(day, 1));
            const items = mine.map((occurrence) => ({ top: topOf(occurrence.at), height: occurrence.kind === "app-run" ? CHIP_HEIGHT : CARD_HEIGHT }));
            const lanes = layLanes(items);
            const ghostAt = move.drag?.overAt;
            const ghostHere = ghostAt != null && ghostAt >= day && ghostAt < addDays(day, 1);
            const dragged = move.drag ? occurrences.find((occurrence) => occurrence.key === move.drag!.key) : undefined;
            return (
              <div key={day} data-day-column={day} className={cn("relative border-l border-hairline/40", day === today && "bg-accent/[0.04]")}
                style={{ height }}>
                {rows.map((hour, index) => <div key={`line-${hour}`} aria-hidden="true" className="pointer-events-none absolute inset-x-0 border-t border-hairline/30" style={{ top: index * HOUR_HEIGHT }} />)}
                {rows.map((hour, index) => {
                  const at = atLocalTime(day, `${String(hour).padStart(2, "0")}:00`);
                  const label = t("automations.cal.slot", { when: `${longDay(at)}, ${clock(at)}` });
                  const past = at + HOUR_MS <= now;
                  const busy = mine.some((occurrence) => occurrence.at >= at && occurrence.at < at + HOUR_MS);
                  return (
                    <button key={hour} type="button" data-slot-at={at} data-slot-past={past ? "" : undefined} aria-label={label} title={label} onClick={() => onSlot(at)}
                      className={cn("group absolute inset-x-0.5 z-[1] flex h-[38px] items-center justify-center rounded-md text-accent-text hover:bg-accent/10 focus-visible:bg-accent/10", move.drag && past && "pointer-events-none")} style={{ top: index * HOUR_HEIGHT }}>
                      {!busy && <Plus size={14} aria-hidden="true" className="opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 focus-visible:opacity-100 touch:opacity-100" />}
                    </button>
                  );
                })}
                {mine.map((occurrence, index) => {
                  const automation = automations.get(occurrence.automationId);
                  const { lane, lanes: count } = lanes[index]!;
                  const style = oneColumn
                    ? { top: items[index]!.top, height: items[index]!.height, left: 3, width: `min(${DAY_CARD_WIDTH}px, calc(100% - 6px))` }
                    : { top: items[index]!.top, height: items[index]!.height, left: `calc(${(lane / count) * 100}% + 3px)`, width: `calc(${100 / count}% - 6px)` };
                  const look: CardLook = { selected: selectedKey === occurrence.key, sibling: siblingOf(occurrence), emphasis: emphasisOf(occurrence.automationId), lifted: move.drag?.key === occurrence.key };
                  const name = automation?.name ?? "";
                  const open = () => { if (!move.consumeClick()) onOpen(occurrence); };
                  if (occurrence.kind === "app-run") {
                    return <RunChip key={occurrence.key} occurrence={occurrence} name={name} start={automation?.starts.find((start) => start.id === occurrence.startId)} look={look} showName={oneColumn} style={{ top: style.top, left: 3 }} onOpen={open} />;
                  }
                  const reason = occurrence.kind !== "scheduled" ? undefined : occurrence.paused ? "automations-cal-paused" : !occurrence.canMove ? "automations-cal-cannot-move" : undefined;
                  return <OccurrenceCard key={occurrence.key} occurrence={occurrence} name={name} stepBotIds={automation?.stepBotIds ?? []} bots={bots} look={look} oneColumn={oneColumn} style={style}
                    describedBy={reason} onOpen={open} onPress={occurrence.canMove ? (event) => move.begin(occurrence, event) : undefined} />;
                })}
                {ghostHere && dragged && (
                  <div data-ghost="" className={cn("pointer-events-none absolute z-[4] flex flex-col justify-center overflow-hidden rounded-lg border-[1.5px] border-dashed border-accent bg-accent/20 px-2 text-left text-ink shadow-lg")}
                    style={{ top: topOf(ghostAt!) + (topOf(dragged.at) % HOUR_HEIGHT), height: CARD_HEIGHT, left: 3, ...(oneColumn ? { width: `min(${DAY_CARD_WIDTH}px, calc(100% - 6px))` } : { right: 3 }) }}>
                    <span className="block truncate text-[12px] font-semibold leading-4">{automations.get(dragged.automationId)?.name}</span>
                    <span className="block truncate text-[12px] leading-4 text-accent-text">{move.drag?.phrase}</span>
                  </div>
                )}
                {day === today && <div data-now-line="" className="pointer-events-none absolute inset-x-0 z-[4] -mt-px h-0.5 bg-accent" style={{ top: topOf(now) }}><span className="absolute -left-[5px] -top-1 size-2.5 rounded-full bg-accent" /></div>}
              </div>
            );
          })}
        </div>
        {hours.after && note(t("automations.cal.after", { time: `${GRID_LAST_HOUR}:00` }), "bottom")}
      </div>
      <span id="automations-cal-cannot-move" hidden>{t("automations.cal.cannotMove")}</span>
      <span id="automations-cal-paused" hidden>{t("automations.cal.state.paused")}</span>
    </div>
  );
}
