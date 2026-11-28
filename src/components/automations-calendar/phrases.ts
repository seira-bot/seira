import type { SchedulePhrase, ShownOccurrenceLike } from "./model";
import { intlLocale, t } from "@/lib/i18n";
import { startOfDay } from "@/lib/routine-calendar";
import type { RoutineSchedule } from "@/lib/routines";

const pad = (value: number) => String(value).padStart(2, "0");

export const clock = (at: number) => `${pad(new Date(at).getHours())}:${pad(new Date(at).getMinutes())}`;
export const longDay = (at: number) => new Date(at).toLocaleDateString(intlLocale(), { weekday: "long", day: "numeric", month: "long" });
export const shortDay = (at: number) => new Date(at).toLocaleDateString(intlLocale(), { weekday: "short", day: "numeric", month: "short" });

/** Sunday is 0, as in a schedule. 29 Nov 2026 is a Sunday. */
export const weekdayName = (day: number) => new Date(2026, 10, 29 + day).toLocaleDateString(intlLocale(), { weekday: "long" });

export function schedulePhrase(phrase: SchedulePhrase): string {
  if (phrase.date !== undefined) return t("automations.cal.phrase.once", { date: shortDay(phrase.date), time: phrase.time });
  if (phrase.days === "all") return t("automations.cal.phrase.daily", { time: phrase.time });
  const days = new Intl.ListFormat(intlLocale(), { style: "long", type: "conjunction" }).format(phrase.days.map(weekdayName));
  return t("automations.cal.phrase.weekly", { days, time: phrase.time });
}

export function occurrenceLabel(occurrence: ShownOccurrenceLike, name: string): string {
  const status = occurrence.kind === "missed" ? "missed"
    : occurrence.kind === "scheduled" ? (occurrence.paused ? "paused" : occurrence.needsYou ? "needsYou" : null)
      : occurrence.runStatus ?? null;
  return [name, `${longDay(occurrence.at)}, ${clock(occurrence.at)}`, status && t(`automations.cal.state.${status}`)].filter(Boolean).join(", ");
}

export interface SlotChoice { id: "once" | "weekly" | "daily"; label: string; phrase: string }

/** What a new automation placed on a slot can mean: once, every week on that day, or every day. */
export function slotChoices(at: number): SlotChoice[] {
  const date = new Date(at);
  const time = clock(at);
  const day = date.getDay();
  return [
    { id: "once", label: t("automations.cal.new.once", { date: shortDay(at), time }), phrase: schedulePhrase({ days: [day], time, date: startOfDay(at) }) },
    { id: "weekly", label: t("automations.cal.new.weekly", { day: weekdayName(day), time }), phrase: schedulePhrase({ days: [day], time }) },
    { id: "daily", label: t("automations.cal.new.daily", { time }), phrase: schedulePhrase({ days: "all", time }) },
  ];
}

/** The schedule a slot choice stands for. */
export function slotSchedule(at: number, choice: SlotChoice["id"]): RoutineSchedule {
  if (choice === "once") return { type: "once", at };
  const day = new Date(at).getDay();
  return { type: "daily", time: clock(at), weekdays: choice === "daily" ? [0, 1, 2, 3, 4, 5, 6] : [day] };
}
