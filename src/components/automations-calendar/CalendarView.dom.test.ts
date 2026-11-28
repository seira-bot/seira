// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CalendarAutomation, CalendarStart } from "@/lib/automation-calendar";
import type { EngineLimit } from "@/lib/limit-resets";
import type { RoutineRun, RoutineSchedule } from "@/lib/routines";
import type { Bot } from "@/state/store";
import { CalendarView } from "./CalendarView";

const loadRunsFrom = vi.hoisted(() => vi.fn());
vi.mock("@/state/older-routine-runs", () => ({ useRoutineRunsFrom: (start: number) => loadRunsFrom(start) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 11, 27, 18, 40); // Friday
const ALL = [0, 1, 2, 3, 4, 5, 6];
const bot = (id: string, name: string): Bot => ({ id, threadId: `${id}-t`, name, title: "", description: "", color: "blue", notifications: false, unread: false, busy: false, messages: [], section: "" } as unknown as Bot);
const bots = [bot("b1", "Scout"), bot("b2", "Ledger"), bot("b3", "Atlas"), bot("b4", "Nova")];

const schedule = (id: string, value: RoutineSchedule, extra: Partial<Extract<CalendarStart, { kind: "schedule" }>> = {}): CalendarStart => ({ id, kind: "schedule", schedule: value, enabled: true, ...extra });
let sequence = 0;
const run = (routineId: string, scheduledFor: number, status: RoutineRun["status"] = "completed"): RoutineRun => ({
  id: `run-${++sequence}`, routineId, routineName: "x", target: "bot", botId: "b1", runOn: "seira", scheduledFor, startedAt: scheduledFor, createdAt: scheduledFor, status, manual: false,
} as RoutineRun);
const automation = (id: string, starts: CalendarStart[], extra: Partial<CalendarAutomation> = {}): CalendarAutomation => ({
  id, name: id, enabled: true, draft: false, manual: false, needsYou: false, statusLine: `${id} line`, starts, stepBotIds: ["b1"], runs: [], ...extra,
});
const weekly = automation("Weekly sales check", [schedule("r-weekly", { type: "daily", time: "10:00", weekdays: [1] })]);
const daily = (name: string, time = "09:00") => automation(name, [schedule(`r-${name}`, { type: "daily", time, weekdays: ALL })]);

let root: Root | null = null;
function mount(list: CalendarAutomation[], props: Partial<Parameters<typeof CalendarView>[0]> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const handlers = { onOpen: vi.fn(), onNew: vi.fn(), onToggle: vi.fn(), saveSchedule: vi.fn(async () => {}) };
  root = createRoot(container);
  const render = (next: Partial<Parameters<typeof CalendarView>[0]> = {}) => act(() => root!.render(createElement(CalendarView, { automations: list, bots, engines: [], advanced: false, selectedId: null, now: NOW, ...handlers, ...props, ...next })));
  render();
  return { container, ...handlers, render };
}
const click = (element: Element) => act(() => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
const fire = (element: Element, type: string, init: MouseEventInit = {}) => act(() => { element.dispatchEvent(new MouseEvent(type, { bubbles: true, ...init })); });
const byText = (container: ParentNode, selector: string, text: string) => [...container.querySelectorAll(selector)].find((candidate) => candidate.textContent?.includes(text))!;
const card = (container: ParentNode, key: string) => container.querySelector(`[data-occurrence="${key}"]`) as HTMLElement | null;
const cards = (container: ParentNode) => [...container.querySelectorAll<HTMLElement>("[data-occurrence]")];
const nextWeek = (container: ParentNode) => click(container.querySelector("[aria-label='Next dates']")!);
const slot = (container: ParentNode, when: number) => container.querySelector(`[data-slot-at="${when}"]`)!;

beforeEach(() => { window.innerWidth = 1280; loadRunsFrom.mockClear(); });
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("rail", () => {
  it("lists every automation with its status line and switch, and a draft says it has no start", () => {
    const draft = automation("Idea", [], { draft: true, enabled: false, statusLine: "" });
    const { container, onToggle } = mount([weekly, daily("Daily"), draft]);
    const rows = [...container.querySelectorAll("[data-rail-row]")];
    expect(rows.map((row) => row.getAttribute("data-rail-row"))).toEqual(["Weekly sales check", "Daily", "Idea"]);
    expect(rows[0]!.textContent).toContain("Weekly sales check line");
    expect(rows[2]!.textContent).toContain("Draft · no start yet");
    expect(rows[2]!.querySelector("[role=switch]")).toBeNull();
    click(rows[0]!.querySelector("[role=switch]")!);
    expect(onToggle).toHaveBeenCalledWith(weekly);
  });

  it("lights the cards of the row under the pointer and dims the others", () => {
    const { container } = mount([weekly, daily("Daily")]);
    fire(container.querySelector("[data-rail-row='Daily']")!, "mouseover");
    expect(cards(container).filter((item) => item.getAttribute("data-automation-id") === "Daily").every((item) => item.getAttribute("data-highlight") === "on")).toBe(true);
    expect(cards(container).filter((item) => item.getAttribute("data-automation-id") === "Weekly sales check").every((item) => item.getAttribute("data-highlight") === "dim")).toBe(true);
    fire(container.querySelector("[data-rail-row='Daily']")!, "mouseout");
    expect(cards(container).every((item) => !item.hasAttribute("data-highlight"))).toBe(true);
  });
});

describe("cards", () => {
  it("shows one fixed-height card per time with the name, up to three bots and the time", () => {
    const four = automation("Round", [schedule("r1", { type: "daily", time: "10:00", weekdays: [1] })], { stepBotIds: ["b1", "b2", "b3", "b4"] });
    const { container } = mount([four]);
    nextWeek(container);
    const found = cards(container);
    expect(found).toHaveLength(1);
    expect(found[0]!.style.height).toBe("36px");
    expect(found[0]!.textContent).toContain("Round");
    expect(found[0]!.textContent).toContain("10:00");
    expect(found[0]!.querySelectorAll("[data-step-avatars] > span")).toHaveLength(3);
  });

  it("marks a chain on every card of an automation with two schedule starts and rings the siblings of the selected one", () => {
    const chain = automation("Chain", [schedule("c1", { type: "daily", time: "09:00", weekdays: [6] }), schedule("c2", { type: "daily", time: "15:00", weekdays: [6] })]);
    const { container, render, onOpen } = mount([chain], { selectedId: "Chain" });
    const found = cards(container);
    expect(found).toHaveLength(2);
    expect(found.every((item) => item.querySelector("[data-chain]"))).toBe(true);
    click(found[0]!);
    expect(onOpen).toHaveBeenCalledWith("Chain", "c1", { at: at(2026, 11, 28, 9) });
    render({ selectedId: "Chain" });
    expect(card(container, `Chain|c1|${at(2026, 11, 28, 9)}`)!.hasAttribute("data-selected")).toBe(true);
    expect(card(container, `Chain|c2|${at(2026, 11, 28, 15)}`)!.hasAttribute("data-sibling")).toBe(true);
  });

  it("shows a check for a finished run, a red cross for a failed one, a dashed card for a paused automation and a warning card for one that needs the person", () => {
    const ran = automation("Ran", [schedule("rr", { type: "daily", time: "09:00", weekdays: [5] })], { runs: [run("rr", at(2026, 11, 27, 9)), run("rr", at(2026, 11, 27, 11), "failed")] });
    const paused = automation("Paused", [schedule("rp", { type: "daily", time: "20:00", weekdays: [6] })], { enabled: false });
    const needs = automation("Needs", [schedule("rn", { type: "daily", time: "21:00", weekdays: [6] })], { needsYou: true });
    const { container } = mount([ran, paused, needs]);
    const done = card(container, `Ran|rr|${at(2026, 11, 27, 9)}`)!;
    expect(done.getAttribute("data-run-status")).toBe("done");
    expect(done.querySelector("svg")).not.toBeNull();
    expect(card(container, `Ran|rr|${at(2026, 11, 27, 11)}`)!.getAttribute("data-run-status")).toBe("failed");
    expect(card(container, `Paused|rp|${at(2026, 11, 28, 20)}`)!.hasAttribute("data-paused")).toBe(true);
    expect(card(container, `Needs|rn|${at(2026, 11, 28, 21)}`)!.hasAttribute("data-needs-you")).toBe(true);
  });

  it("shows a red dot and Couldn't start for a time an automation that needs the person missed", () => {
    const needs = automation("Needs", [schedule("rn", { type: "daily", time: "09:00", weekdays: ALL })], { needsYou: true });
    const { container } = mount([needs]);
    const missed = card(container, `Needs|rn|${at(2026, 11, 27, 9)}`)!;
    expect(missed.getAttribute("data-kind")).toBe("missed");
    expect(missed.textContent).toContain("Couldn't start");
    expect(missed.querySelector(".bg-danger")).not.toBeNull();
    expect(missed.getAttribute("aria-label")).toContain("couldn't start");
  });

  it("shows a past run of an app start as a small chip with the app logo, and the name only in Day", () => {
    const app = automation("Invoices", [{ id: "a1", kind: "app", app: "gmail" }], { runs: [run("a1", at(2026, 11, 27, 14, 30))] });
    const { container } = mount([app]);
    const chip = card(container, `Invoices|a1|${at(2026, 11, 27, 14, 30)}`)!;
    expect(chip.getAttribute("data-kind")).toBe("app-run");
    expect(chip.querySelector("img")?.getAttribute("src")).toContain("gmail");
    expect(chip.textContent).toBe("14:30");
    click(byText(container, "[data-range]", "Day"));
    act(() => undefined);
  });

  it("opens a past run with its run id", () => {
    const ran = automation("Ran", [schedule("rr", { type: "daily", time: "09:00", weekdays: [5] })], { runs: [run("rr", at(2026, 11, 27, 9))] });
    const { container, onOpen } = mount([ran]);
    click(cards(container)[0]!);
    expect(onOpen).toHaveBeenCalledWith("Ran", "rr", { at: at(2026, 11, 27, 9), runId: ran.runs[0]!.id });
  });
});

describe("Day, Week and Month", () => {
  it("offers all three, starts on Week wide and on Day narrow", () => {
    const wide = mount([weekly]);
    expect([...wide.container.querySelectorAll("[data-range]")].map((item) => item.textContent)).toEqual(["Day", "Week", "Month"]);
    expect(wide.container.querySelector("[data-time-grid]")!.getAttribute("data-time-grid")).toBe("week");
    act(() => root!.unmount());
    document.body.innerHTML = "";
    window.innerWidth = 375;
    const narrow = mount([weekly]);
    expect(narrow.container.querySelectorAll("[data-range]")).toHaveLength(3);
    expect(narrow.container.querySelector("[data-time-grid]")!.getAttribute("data-time-grid")).toBe("day");
  });

  it("shows the steps on a card and the automation name on a chip in Day", () => {
    const steps = automation("Round", [schedule("r1", { type: "daily", time: "20:00", weekdays: ALL })], { stepBotIds: ["b1", "b2"] });
    const app = automation("Invoices", [{ id: "a1", kind: "app", app: "gmail" }], { runs: [run("a1", at(2026, 11, 27, 14, 30))] });
    const { container } = mount([steps, app]);
    click(byText(container, "[data-range]", "Day"));
    expect(container.querySelectorAll("[data-day-column]")).toHaveLength(1);
    expect(container.querySelector("[data-kind=scheduled]")!.textContent).toContain("Scout → Ledger");
    click(byText(container, "button", "Today"));
    expect(container.querySelector("[data-kind=app-run]")!.textContent).toContain("Invoices");
  });

  it("shows 07:00 to 22:00 at 40 px an hour with the two rows for the empty ends", () => {
    const { container } = mount([weekly]);
    const labels = [...container.querySelectorAll("[data-hour-column] > span:not([data-reset-mark])")].map((item) => item.textContent);
    expect(labels[0]).toBe("07:00");
    expect(labels.at(-1)).toBe("21:00");
    expect((container.querySelector("[data-day-column]") as HTMLElement).style.height).toBe("600px");
    expect(container.querySelector("[data-fold=top]")!.textContent).toBe("Nothing runs before 07:00");
    expect(container.querySelector("[data-fold=bottom]")!.textContent).toBe("Nothing runs after 22:00");
    expect(container.querySelector("[data-now-line]")).not.toBeNull();
  });

  it("extends the grid to the hour of a card that falls outside and drops that fold row", () => {
    const night = automation("Night", [schedule("rn", { type: "daily", time: "23:30", weekdays: [6] })]);
    const early = automation("Early", [schedule("re", { type: "daily", time: "05:15", weekdays: [6] })]);
    const { container } = mount([night, early]);
    expect(container.querySelector("[data-fold]")).toBeNull();
    expect((container.querySelector("[data-day-column]") as HTMLElement).style.height).toBe(`${(24 - 5) * 40}px`);
  });

  it("shows an every-day automation as one band per week, a day's overflow as + N more, and marks today", () => {
    const busy = Array.from({ length: 5 }, (_, index) => automation(`Once ${index}`, [schedule(`o${index}`, { type: "once", at: at(2026, 11, 30, 9 + index) })]));
    const { container } = mount([daily("Daily"), ...busy]);
    click(byText(container, "[data-range]", "Month"));
    expect(container.querySelectorAll("[data-band]")).toHaveLength(2);
    expect(container.querySelector("[data-more]")!.textContent).toBe("+ 3 more");
    expect(container.querySelector("[data-today]")!.getAttribute("data-month-day")).toBe(String(at(2026, 11, 27)));
    click(container.querySelector(`[data-month-day="${at(2026, 11, 30)}"] button`)!);
    expect(container.querySelector("[data-time-grid]")!.getAttribute("data-time-grid")).toBe("day");
    expect(container.querySelector("[data-range-title]")!.textContent).toContain("30");
  });
});

describe("older runs", () => {
  it("asks for the runs from the first visible day of Week, the next Week and Month", () => {
    const { container } = mount([weekly]);
    expect(loadRunsFrom).toHaveBeenLastCalledWith(at(2026, 11, 23));
    nextWeek(container);
    expect(loadRunsFrom).toHaveBeenLastCalledWith(at(2026, 11, 30));
    click(byText(container, "[data-range]", "Month"));
    expect(loadRunsFrom).toHaveBeenLastCalledWith(at(2026, 11, 30));
    click(container.querySelector("[aria-label='Previous dates']")!);
    expect(loadRunsFrom).toHaveBeenLastCalledWith(at(2026, 10, 26));
  });
});

describe("empty slots and the empty calendar", () => {
  it("asks for a new automation at the hour of a slot", () => {
    const { container, onNew } = mount([weekly]);
    nextWeek(container);
    click(slot(container, at(2026, 12, 1, 10)));
    expect(onNew).toHaveBeenCalledWith(at(2026, 12, 1, 10));
  });

  it("shows the plus mark only on a slot that holds no card", () => {
    const { container } = mount([weekly]);
    nextWeek(container);
    expect(slot(container, at(2026, 11, 30, 10)).querySelector("svg")).toBeNull();
    expect(slot(container, at(2026, 12, 1, 10)).querySelector("svg")).not.toBeNull();
  });

  it("says nothing runs and offers New automation when no automation has a schedule, and keeps drafts in the rail", () => {
    const draft = automation("Idea", [], { draft: true, enabled: false, statusLine: "" });
    const { container, onNew } = mount([draft]);
    const empty = container.querySelector("[data-calendar-empty]")!;
    expect(empty.querySelector("p")!.textContent).toBe("Nothing runs on a schedule yet.");
    expect(empty.querySelectorAll("button")).toHaveLength(1);
    click(empty.querySelector("button")!);
    expect(onNew).toHaveBeenCalledWith();
    expect(container.querySelector("[data-rail-row='Idea']")).not.toBeNull();
  });
});

describe("the picked card", () => {
  it("rings no sibling after the rail opens another automation", () => {
    const chain = automation("Chain", [schedule("c1", { type: "daily", time: "09:00", weekdays: [6] }), schedule("c2", { type: "daily", time: "15:00", weekdays: [6] })]);
    const other = daily("Other");
    const { container, render } = mount([chain, other], { selectedId: "Chain" });
    click(cards(container).find((item) => item.getAttribute("data-occurrence")!.startsWith("Chain|c1"))!);
    render({ selectedId: "Chain" });
    expect(container.querySelector("[data-sibling]")).not.toBeNull();
    render({ selectedId: "Other" });
    expect(container.querySelector("[data-sibling]")).toBeNull();
    expect(container.querySelector("[data-selected]")).toBeNull();
  });
});

describe("a run chip's mark", () => {
  it("shows the mark of its own status", () => {
    const app = automation("Invoices", [{ id: "a1", kind: "app", app: "gmail" }], { runs: [run("a1", at(2026, 11, 27, 9), "failed"), run("a1", at(2026, 11, 27, 10), "completed"), run("a1", at(2026, 11, 27, 11), "running")] });
    const { container } = mount([app]);
    const mark = (hour: number) => card(container, `Invoices|a1|${at(2026, 11, 27, hour)}`)!.querySelector("[data-status-icon]")!.getAttribute("data-status-icon");
    expect([mark(9), mark(10), mark(11)]).toEqual(["failed", "done", "running"]);
  });
});

describe("limit resets", () => {
  it("grows the grid to show a reset mark outside the usual hours", () => {
    const late = { engine: "claude", name: "Claude", resetsAt: at(2026, 11, 28, 23, 30), usedPercent: 90, blocked: false } as unknown as EngineLimit;
    const { container } = mount([weekly], { engines: [late], advanced: true });
    expect(container.querySelectorAll("[data-reset-mark]")).toHaveLength(1);
    expect((container.querySelector("[data-day-column]") as HTMLElement).style.height).toBe(`${(24 - 7) * 40}px`);
  });

  const engine = { engine: "claude", name: "Claude", resetsAt: at(2026, 11, 28, 15, 0), usedPercent: 90, blocked: false } as unknown as EngineLimit;
  it("shows a mark in the hour column only while Advanced is on", () => {
    const on = mount([weekly], { engines: [engine], advanced: true });
    expect(on.container.querySelectorAll("[data-reset-mark]")).toHaveLength(1);
    on.render({ engines: [engine], advanced: false });
    expect(on.container.querySelectorAll("[data-reset-mark]")).toHaveLength(0);
  });
});

describe("keyboard names", () => {
  it("makes cards and slots buttons named with the automation, the day and the time", () => {
    const { container } = mount([weekly]);
    nextWeek(container);
    const found = cards(container)[0]!;
    expect(found.tagName).toBe("BUTTON");
    expect(found.getAttribute("aria-label")).toMatch(/^Weekly sales check, .*Monday.*, 10:00$/);
    const target = slot(container, at(2026, 12, 1, 10));
    expect(target.tagName).toBe("BUTTON");
    expect(target.getAttribute("aria-label")).toMatch(/^New automation, .*Tuesday.*, 10:00$/);
  });
});

describe("dragging a card", () => {
  const mountNext = (list: CalendarAutomation[]) => { const mounted = mount(list); nextWeek(mounted.container); return mounted; };
  const key = `Weekly sales check|r-weekly|${at(2026, 11, 30, 10)}`;
  const pointerdown = (element: Element) => fire(element, "pointerdown", { clientX: 10, clientY: 10, button: 0 });
  const dragTo = (container: ParentNode, when: number) => fire(slot(container, when), "pointermove", { clientX: 200, clientY: 200 });
  const drop = () => fire(document.body, "pointerup", { clientX: 200, clientY: 200 });
  const settle = async () => { await act(async () => { await Promise.resolve(); }); };

  it("shows a ghost card with the name and the new schedule over the slot", () => {
    const { container } = mountNext([weekly]);
    pointerdown(card(container, key)!);
    dragTo(container, at(2026, 12, 1, 14));
    const ghost = container.querySelector("[data-ghost]")!;
    expect(ghost.textContent).toBe("Weekly sales checkevery Tuesday at 14:00");
    expect(container.querySelector("[data-cal-scroll]")!.className).toContain("pointer-events-none");
    expect(container.querySelector(`[data-day-column="${at(2026, 12, 1)}"] [data-ghost]`)).not.toBeNull();
  });

  it("changes that start's schedule on drop, says so with Undo, and Undo restores it", async () => {
    const { container, saveSchedule, render } = mountNext([weekly]);
    pointerdown(card(container, key)!);
    dragTo(container, at(2026, 12, 1, 14));
    drop();
    await settle();
    expect(saveSchedule).toHaveBeenCalledWith("r-weekly", { type: "daily", time: "14:00", weekdays: [2] });
    const toast = container.querySelector("[data-move-toast]")!;
    expect(toast.textContent).toContain("Weekly sales check now runs every Tuesday at 14:00.");
    render({ automations: [automation("Weekly sales check", [schedule("r-weekly", { type: "daily", time: "14:00", weekdays: [2] })])] });
    click(byText(toast, "button", "Undo"));
    await settle();
    expect(saveSchedule).toHaveBeenLastCalledWith("r-weekly", { type: "daily", time: "10:00", weekdays: [1] });
    expect(container.querySelector("[data-move-toast]")).toBeNull();
  });

  it("changes nothing when the card drops on its own slot", async () => {
    const { container, saveSchedule } = mountNext([weekly]);
    pointerdown(card(container, key)!);
    dragTo(container, at(2026, 11, 30, 10));
    expect(container.querySelector("[data-ghost]")).toBeNull();
    drop();
    await settle();
    expect(saveSchedule).not.toHaveBeenCalled();
    expect(container.querySelector("[data-move-toast]")).toBeNull();
  });

  it("does not drag a past run, and a plain click still opens it", () => {
    const ran = automation("Ran", [schedule("rr", { type: "daily", time: "09:00", weekdays: [5] })], { runs: [run("rr", at(2026, 11, 27, 9))] });
    const { container, saveSchedule, onOpen } = mount([ran]);
    const past = cards(container)[0]!;
    expect(past.hasAttribute("data-can-move")).toBe(false);
    pointerdown(past);
    dragTo(container, at(2026, 11, 28, 14));
    drop();
    expect(saveSchedule).not.toHaveBeenCalled();
    click(past);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("opens the panel on a click without movement", () => {
    const { container, onOpen } = mountNext([weekly]);
    const target = card(container, key)!;
    pointerdown(target);
    drop();
    click(target);
    expect(onOpen).toHaveBeenCalledWith("Weekly sales check", "r-weekly", { at: at(2026, 11, 30, 10) });
  });

  it("does not move a custom repeat rule and describes where to change it", () => {
    const cron = automation("Cron", [schedule("rc", { type: "cron", expression: "0 10 * * *", timeZone: "UTC" } as RoutineSchedule, { nextRunAt: at(2026, 11, 28, 10) })]);
    const { container } = mount([cron]);
    const target = cards(container)[0]!;
    expect(target.hasAttribute("data-can-move")).toBe(false);
    const described = container.querySelector(`#${target.getAttribute("aria-describedby")}`)!;
    expect(described.textContent).toBe("Change when it runs in the panel.");
  });

  it("returns the card and says it could not move when the save fails", async () => {
    const { container, saveSchedule } = mountNext([weekly]);
    const before = cards(container).map((item) => item.getAttribute("data-occurrence"));
    saveSchedule.mockRejectedValueOnce(new Error("offline"));
    pointerdown(card(container, key)!);
    dragTo(container, at(2026, 12, 1, 14));
    drop();
    await settle();
    const toast = container.querySelector("[data-move-toast]")!;
    expect(toast.textContent).toContain("Couldn't move Weekly sales check. Try again.");
    expect(toast.textContent).not.toContain("Undo");
    expect(cards(container).map((item) => item.getAttribute("data-occurrence"))).toEqual(before);
    expect(card(container, key)!.getAttribute("aria-label")).toContain("10:00");
    expect(container.querySelector("[data-ghost]")).toBeNull();
  });

  it("gives no ghost and saves nothing for a drop on a slot that is already past", async () => {
    const { container, saveSchedule } = mount([daily("Daily")]);
    const future = `Daily|r-Daily|${at(2026, 11, 28, 9)}`;
    expect(slot(container, at(2026, 11, 27, 10)).hasAttribute("data-slot-past")).toBe(true);
    expect(slot(container, at(2026, 11, 28, 10)).hasAttribute("data-slot-past")).toBe(false);
    pointerdown(card(container, future)!);
    dragTo(container, at(2026, 11, 27, 10));
    expect(container.querySelector("[data-ghost]")).toBeNull();
    drop();
    await settle();
    expect(saveSchedule).not.toHaveBeenCalled();
    expect(container.querySelector("[data-move-toast]")).toBeNull();
  });

  it("picks the slot under a card that sits over it", async () => {
    const over = at(2026, 12, 1, 14);
    const other = automation("Other", [schedule("r-other", { type: "daily", time: "14:00", weekdays: [2] })]);
    const { container, saveSchedule } = mountNext([weekly, other]);
    const sitting = card(container, `Other|r-other|${over}`)!;
    const original = document.elementsFromPoint;
    document.elementsFromPoint = () => [sitting, slot(container, over)];
    try {
      pointerdown(card(container, key)!);
      fire(sitting, "pointermove", { clientX: 200, clientY: 200 });
      expect(container.querySelector("[data-ghost]")).not.toBeNull();
      drop();
      await settle();
    } finally {
      document.elementsFromPoint = original;
    }
    expect(saveSchedule).toHaveBeenCalledWith("r-weekly", { type: "daily", time: "14:00", weekdays: [2] });
  });

  it("ignores a second drag of the same start while its save runs", async () => {
    const { container, saveSchedule } = mountNext([weekly]);
    let finish: () => void = () => {};
    saveSchedule.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    pointerdown(card(container, key)!);
    dragTo(container, at(2026, 12, 1, 14));
    drop();
    await settle();
    pointerdown(card(container, key)!);
    dragTo(container, at(2026, 12, 2, 16));
    expect(container.querySelector("[data-ghost]")).toBeNull();
    drop();
    await settle();
    expect(saveSchedule).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    await settle();
    pointerdown(card(container, key)!);
    dragTo(container, at(2026, 12, 2, 16));
    expect(container.querySelector("[data-ghost]")).not.toBeNull();
    drop();
  });

  it("runs one Undo at a time, says so when Undo fails, and drops Undo when the schedule changed since", async () => {
    const { container, saveSchedule, render } = mountNext([weekly]);
    pointerdown(card(container, key)!);
    dragTo(container, at(2026, 12, 1, 14));
    drop();
    await settle();
    let finish: () => void = () => {};
    saveSchedule.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const undo = () => byText(container.querySelector("[data-move-toast]")!, "button", "Undo") as HTMLButtonElement;
    const moved = automation("Weekly sales check", [schedule("r-weekly", { type: "daily", time: "14:00", weekdays: [2] })]);
    render({ automations: [moved] });
    click(undo());
    click(undo());
    expect(saveSchedule).toHaveBeenCalledTimes(2);
    expect(undo().disabled).toBe(true);
    await act(async () => { finish(); });
    await settle();
    expect(container.querySelector("[data-move-toast]")).toBeNull();

    render({ automations: [weekly] });
    pointerdown(card(container, key)!);
    dragTo(container, at(2026, 12, 1, 14));
    drop();
    await settle();
    render({ automations: [moved] });
    saveSchedule.mockRejectedValueOnce(new Error("offline"));
    click(undo());
    await settle();
    expect(container.querySelector("[data-move-toast]")!.textContent).toContain("Couldn't undo the move of Weekly sales check.");
  });

  it("drops Undo without saving when the schedule is no longer the moved one", async () => {
    const { container, saveSchedule, render } = mountNext([weekly]);
    pointerdown(card(container, key)!);
    dragTo(container, at(2026, 12, 1, 14));
    drop();
    await settle();
    render({ automations: [automation("Weekly sales check", [schedule("r-weekly", { type: "daily", time: "08:00", weekdays: [3] })])] });
    click(byText(container.querySelector("[data-move-toast]")!, "button", "Undo"));
    await settle();
    expect(saveSchedule).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-move-toast]")).toBeNull();
  });
});
