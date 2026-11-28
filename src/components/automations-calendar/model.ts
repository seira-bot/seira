import { occurrencesIn, monthCells, type CalendarAutomation, type MonthBand, type MonthCell, type Occurrence, type SchedulePhrase } from "@/lib/automation-calendar";

export type { SchedulePhrase };

export interface ShownOccurrence extends Occurrence {
  /** A schedule that is switched off still shows where it would run. */
  paused: boolean;
  needsYou: boolean;
}

export type ShownOccurrenceLike = Pick<ShownOccurrence, "at" | "kind" | "paused" | "needsYou" | "runStatus">;

const isPausedStart = (automation: CalendarAutomation, start: CalendarAutomation["starts"][number]) =>
  !automation.draft && start.kind === "schedule" && (!automation.enabled || !start.enabled);

/** The engine plans only for what is on; a paused automation is planned as if on, then marked. */
function asIfOn(automations: readonly CalendarAutomation[]): CalendarAutomation[] {
  return automations.map((automation) => automation.draft || !automation.starts.some((start) => isPausedStart(automation, start)) ? automation : {
    ...automation,
    enabled: true,
    starts: automation.starts.map((start) => (start.kind === "schedule" ? { ...start, enabled: true } : start)),
  });
}

function mark(automations: readonly CalendarAutomation[], occurrence: Occurrence): ShownOccurrence {
  const automation = automations.find((candidate) => candidate.id === occurrence.automationId);
  const start = automation?.starts.find((candidate) => candidate.id === occurrence.startId);
  const paused = occurrence.kind === "scheduled" && !!automation && !!start && isPausedStart(automation, start);
  return { ...occurrence, paused, canMove: occurrence.canMove && !paused, needsYou: automation?.needsYou === true };
}

export function shownOccurrences(automations: readonly CalendarAutomation[], from: number, to: number, now: number): ShownOccurrence[] {
  return occurrencesIn(asIfOn(automations), from, to, now).map((occurrence) => mark(automations, occurrence));
}

export interface ShownMonthCell extends Omit<MonthCell, "chips"> { chips: ShownOccurrence[] }

export function shownMonth(automations: readonly CalendarAutomation[], anchor: number, now: number): { cells: ShownMonthCell[]; bands: Array<MonthBand & { paused: boolean }> } {
  const month = monthCells(asIfOn(automations), anchor, now);
  return {
    cells: month.cells.map((cell) => ({ ...cell, chips: cell.chips.map((chip) => mark(automations, chip)) })),
    bands: month.bands.map((band) => {
      const automation = automations.find((candidate) => candidate.id === band.automationId);
      const start = automation?.starts.find((candidate) => candidate.id === band.startId);
      return { ...band, paused: !!automation && !!start && isPausedStart(automation, start) };
    }),
  };
}

/** Side-by-side lanes for items that overlap in one day column. */
export function layLanes(items: ReadonlyArray<{ top: number; height: number }>): Array<{ lane: number; lanes: number }> {
  const order = items.map((_, index) => index).sort((left, right) => items[left]!.top - items[right]!.top);
  const result = items.map(() => ({ lane: 0, lanes: 1 }));
  let cluster: number[] = [];
  let laneEnds: number[] = [];
  const close = () => { for (const index of cluster) result[index]!.lanes = Math.max(1, laneEnds.length); cluster = []; laneEnds = []; };
  for (const index of order) {
    const item = items[index]!;
    if (cluster.length && laneEnds.every((end) => end <= item.top)) close();
    let lane = laneEnds.findIndex((end) => end <= item.top);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
    laneEnds[lane] = item.top + item.height;
    result[index]!.lane = lane;
    cluster.push(index);
  }
  close();
  return result;
}
