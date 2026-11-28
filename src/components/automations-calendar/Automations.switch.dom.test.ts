// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";
import { resetWorkflowsForTest } from "@/state/workflows";

const fixture = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  dispatch: vi.fn(),
  api: vi.fn(async (..._args: unknown[]) => ({}) as unknown),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }),
  api: (...args: unknown[]) => fixture.api(...args),
}));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => false }));
vi.mock("@/lib/live-events", () => ({ listenLiveFrames: () => () => {} }));

const { TriggersPage } = await import("../TriggersPage");
const { AutomationPanel } = await import("../automations/AutomationPanel");
const { NewAutomation } = await import("../automations/NewAutomation");
const { automationsFrom } = await import("@/lib/automations");
const { t } = await import("@/lib/i18n");
const { addDays, atLocalTime, startOfDay, startOfWeek } = await import("@/lib/routine-calendar");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const now = Date.now();
const bot = (id: string, name: string, section: string) => ({ id, name, threadId: `${id}-t`, hidden: false, color: "blue", section, messages: [{ id: `${id}-m`, at: now - 5_000 }] }) as unknown as Bot;
const bots = [bot("bot-a", "Scout", "Sales"), bot("bot-b", "Ledger", "Finance")];
const routine = (index: number) => ({ id: `routine-${index}`, name: `Routine ${index}`, prompt: "Do it", botId: index % 2 ? "bot-a" : "bot-b", runOn: "seira", enabled: true, createdAt: now, updatedAt: now,
  schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, nextRunAt: now + 86_400_000, durationMinutes: 30 });

let root: Root | null = null;
function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(element));
  return container;
}
const state = (extra: Record<string, unknown> = {}) => ({
  hydrated: true, bots, groups: [], sections: ["Sales", "Finance"], selectedId: "", routines: Array.from({ length: 10 }, (_, index) => routine(index)), webhooks: [], routineRuns: [], webhookAttempts: [],
  routinesLoadState: "ready", routinesFocus: { view: "calendar" }, webhookIngress: { available: true }, ...extra,
});
const page = () => createElement(TriggersPage, { onBack: vi.fn(), onOpenRoom: vi.fn() });
const settle = async () => { await act(async () => { await Promise.resolve(); }); };

beforeEach(() => {
  resetWorkflowsForTest();
  fixture.dispatch.mockReset();
  fixture.api.mockReset();
  fixture.api.mockResolvedValue({});
});
afterEach(() => { if (root) act(() => root!.unmount()); root = null; document.body.innerHTML = ""; });

describe("the new Automations switch", () => {
  it("keeps today's Calendar while the switch is off", async () => {
    fixture.state = state();
    const container = mount(page());
    await settle();
    expect(container.querySelector("[data-automations-calendar]")).toBeNull();
    expect(container.querySelector("[aria-label='Schedule view']")).not.toBeNull();
    expect(container.querySelector("[aria-label='Calendar range']")).toBeNull();
    expect(container.querySelector("[aria-label='All bots']")).toBeNull();
    expect(container.querySelector("[aria-label='All departments']")).not.toBeNull();
  });

  it("shows the new Calendar with the same department filter, bot filter, view switch and New button as the List", async () => {
    fixture.state = state({ config: { features: { newAutomations: true } } });
    const container = mount(page());
    await settle();
    expect(container.querySelector("[data-automations-calendar]")).not.toBeNull();
    expect(container.querySelector("[aria-label='All departments']")).not.toBeNull();
    expect(container.querySelector("[aria-label='All bots']")).not.toBeNull();
    const views = [...container.querySelectorAll("[aria-label='Show as'] button")].map((item) => item.textContent);
    expect(views).toEqual(expect.arrayContaining(["List", "Calendar"]));
    expect([...container.querySelectorAll("button")].some((item) => item.textContent === "New")).toBe(true);
    expect(container.querySelectorAll("[data-rail-row]")).toHaveLength(10);
  });

  it("changes the cards and the rail when the bot filter changes", async () => {
    fixture.state = state({ config: { features: { newAutomations: true } } });
    const container = mount(page());
    await settle();
    act(() => { (container.querySelector("[aria-label='Next dates']") as HTMLElement).click(); });
    const owners = () => new Set([...container.querySelectorAll("[data-occurrence]")].map((item) => Number(item.getAttribute("data-automation-id")!.split("-")[1]) % 2));
    expect(owners()).toEqual(new Set([0, 1]));
    const select = container.querySelector("select[aria-label='All bots']") as HTMLSelectElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "bot-a");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelectorAll("[data-rail-row]")).toHaveLength(5);
    expect(owners()).toEqual(new Set([1]));
  });

  it("sends the enable request for the rail switch of an automation", async () => {
    fixture.state = state({ config: { features: { newAutomations: true } } });
    const container = mount(page());
    await settle();
    fixture.api.mockResolvedValue({ routine: { ...routine(0), enabled: false } });
    act(() => { (container.querySelector("[data-rail-row='routine-0'] [role=switch]") as HTMLElement).click(); });
    await settle();
    expect(fixture.api).toHaveBeenCalledWith("/api/routines/routine-0", { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "routinePatched" }));
  });

  it("opens the same panel as the List for a card, with the date and time", async () => {
    fixture.state = state({ config: { features: { newAutomations: true } } });
    const container = mount(page());
    await settle();
    act(() => { (container.querySelector("[aria-label='Next dates']") as HTMLElement).click(); });
    act(() => { (container.querySelector("[data-occurrence]") as HTMLElement).click(); });
    expect(container.querySelector("[aria-label='Automation']")).not.toBeNull();
    expect(container.querySelector("[data-occurrence-context]")).not.toBeNull();
  });

  it("drops the date and time of a card when the List opens the same automation", async () => {
    fixture.state = state({ config: { features: { newAutomations: true } } });
    const container = mount(page());
    await settle();
    act(() => { (container.querySelector("[aria-label='Next dates']") as HTMLElement).click(); });
    const first = container.querySelector("[data-occurrence]") as HTMLElement;
    const id = first.getAttribute("data-automation-id")!;
    act(() => { first.click(); });
    expect(container.querySelector("[data-occurrence-context]")).not.toBeNull();
    fixture.state = state({ config: { features: { newAutomations: true } }, routinesFocus: { view: "list" } });
    act(() => root!.render(page()));
    act(() => { (container.querySelector(`[data-automation='${id}'] button`) as HTMLElement).click(); });
    expect(container.querySelector("[aria-label='Automation']")).not.toBeNull();
    expect(container.querySelector("[data-occurrence-context]")).toBeNull();
  });

  it("opens the New box with the slot's day and time for an empty slot", async () => {
    fixture.state = state({ config: { features: { newAutomations: true } } });
    const container = mount(page());
    await settle();
    act(() => { (container.querySelector("[data-slot-at]") as HTMLElement).click(); });
    expect(document.body.textContent).toContain("When should it run?");
  });
});

describe("a slot to the routine editor", () => {
  const nextTuesdayTen = () => {
    const monday = startOfWeek(addDays(startOfDay(Date.now()), 7));
    return atLocalTime(addDays(monday, 1), "10:00");
  };
  const press = (container: ParentNode | Document, text: string) => act(() => { ([...container.querySelectorAll("button")].find((item) => item.textContent === text) as HTMLElement).click(); });
  const pressedRepeat = () => document.querySelector("[role=group][aria-label='Repeat'] [aria-pressed=true]")?.textContent;

  it.each<[string, "routines.repeat.once" | "routines.repeat.weekly" | "routines.repeat.daily"]>([
    ["Once", "routines.repeat.once"],
    ["Every Tuesday at 10:00", "routines.repeat.weekly"],
    ["Every day at 10:00", "routines.repeat.daily"],
  ])("opens Set it up yourself with 10:00 and %s as the start value", async (label, repeatKey) => {
    fixture.state = state({ config: { features: { newAutomations: true } } });
    const container = mount(page());
    await settle();
    act(() => { (container.querySelector("[aria-label='Next dates']") as HTMLElement).click(); });
    act(() => { (container.querySelector(`[data-slot-at="${nextTuesdayTen()}"]`) as HTMLElement).click(); });
    act(() => { ([...document.querySelectorAll("[role=radiogroup] button")].find((item) => item.textContent?.startsWith(label)) as HTMLElement).click(); });
    press(document, "Set it up yourself");
    press(document, "Continue");
    await settle();
    expect((document.querySelector("input[type=time]") as HTMLInputElement).value).toBe("10:00");
    expect(pressedRepeat()).toBe(t(repeatKey));
  });
});

describe("the panel for a Calendar occurrence", () => {
  it("shows the date, the time and the result of a past run", () => {
    fixture.state = state();
    const run = { id: "run-1", routineId: "routine-1", botId: "bot-a", status: "completed", scheduledFor: at(2026, 11, 27, 9), startedAt: at(2026, 11, 27, 9), createdAt: at(2026, 11, 27, 9), output: "All good." };
    const [automation] = automationsFrom({ routines: [routine(1)] as never, webhooks: [], runs: [run] as never });
    const container = mount(createElement(AutomationPanel, { automation: automation!, sentence: "s", occurrence: { at: at(2026, 11, 27, 9), runId: "run-1" }, onClose: vi.fn(), onEdit: vi.fn(), onDeleted: vi.fn() }));
    const context = container.querySelector("[data-occurrence-context]")!;
    expect(context.textContent).toContain("Friday");
    expect(context.textContent).toContain("09:00");
    expect(context.textContent).toContain("✓");
  });
});

describe("the New box for a slot", () => {
  const text = (container: HTMLElement) => {
    const area = container.querySelector("textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, "Check sales");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("keeps its title and offers once, every weekday and every day, once first", () => {
    fixture.state = state();
    const container = mount(createElement(NewAutomation, { slotAt: at(2026, 12, 1, 10), onClose: vi.fn(), onSetUpYourself: vi.fn() }));
    expect(container.querySelector("h2")!.textContent).toBe("What should happen?");
    expect(container.textContent).toContain("When should it run?");
    const chips = [...container.querySelectorAll("[role=radiogroup] button")];
    expect(chips.map((chip) => chip.textContent)).toEqual(["Once · Tue, Dec 1, 10:00", "Every Tuesday at 10:00", "Every day at 10:00"].map((label, index) => (index === 0 ? chips[0]!.textContent : label)));
    expect(chips[0]!.textContent).toMatch(/^Once · .*1.*, 10:00$/);
    expect(chips.map((chip) => chip.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
  });

  it("adds the chosen time to the request that is sent", () => {
    fixture.state = state();
    const container = mount(createElement(NewAutomation, { slotAt: at(2026, 12, 1, 10), onClose: vi.fn(), onSetUpYourself: vi.fn() }));
    text(container);
    act(() => { ([...container.querySelectorAll("[role=radiogroup] button")][1] as HTMLElement).click(); });
    act(() => { ([...container.querySelectorAll("button")].find((item) => item.textContent === "Set it up") as HTMLElement).click(); });
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "send", text: "Check sales\n\nIt should run every Tuesday at 10:00." }));
  });

  it("offers no time without a slot", () => {
    fixture.state = state();
    const container = mount(createElement(NewAutomation, { onClose: vi.fn(), onSetUpYourself: vi.fn() }));
    expect(container.textContent).not.toContain("When should it run?");
  });
});
