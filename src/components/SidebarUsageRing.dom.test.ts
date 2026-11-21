// @vitest-environment happy-dom
// The sidebar footer's usage ring: when it shows, which AI it shows, and the card that opens from it.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { EngineLimit } from "../../shared/limit-reset";
import type { Bot } from "@/state/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const { setLocale } = await import("@/lib/i18n");
const limits = await import("@/lib/limit-resets");
const { SidebarUsageRing } = await import("./EngineUsage");

const NOW = new Date(2026, 9, 19, 10, 0, 0).getTime();
const RESET = new Date(2026, 9, 19, 15, 40, 0).getTime();
const MONTH_END = new Date(2026, 10, 1, 0, 0, 0).getTime();
const HOVER_MS = 300;
const claude = (used: number, extra: Partial<EngineLimit> = {}): EngineLimit => ({
  engine: "claude", name: "Claude", driver: "claude", window: "5-hour", usedPercent: used, resetsAt: RESET, blocked: false, ...extra,
});
const go = (used: number): EngineLimit => ({
  engine: "go", name: "OpenCode", driver: "opencode", window: "monthly", usedPercent: used, resetsAt: MONTH_END, blocked: false,
  windows: [{ window: "monthly", usedPercent: used, resetsAt: MONTH_END }],
});
const bot = (id: string, instanceId: string) => ({ id, name: id, hidden: false, threadId: `t-${id}`, modelSelection: { instanceId, model: "m" }, tasks: [] }) as unknown as Bot;

let root: Root | null = null;
function mount(simple: boolean, shape?: "row" | "column") {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(createElement(SidebarUsageRing, { simple, shape })));
  return container;
}
const serve = (engines: EngineLimit[]) => {
  fixture.api.mockImplementation(async () => ({ checkedAt: NOW, engines }));
  limits.rememberLimits({ checkedAt: NOW, engines });
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ring = (container: HTMLElement) => container.querySelector<HTMLButtonElement>("[data-sidebar-usage]");
const card = () => document.querySelector<HTMLElement>("[data-usage-card]");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  setLocale("en");
  fixture.api.mockReset();
  fixture.state = { bots: [bot("scout", "claude")], selectedId: "scout" };
  serve([claude(40)]);
});
afterEach(() => {
  flushSync(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

it("shows no ring while no connected AI reports usage", () => {
  serve([{ ...claude(0), usedPercent: null, window: null, resetsAt: null }]);
  expect(mount(false).innerHTML).toBe("");
  flushSync(() => root!.unmount());
  serve([]);
  expect(mount(true).innerHTML).toBe("");
});

it("shows the ring in Advanced at a fine tone, with the limit line as its name", () => {
  const found = ring(mount(false))!;
  expect(found.getAttribute("data-sidebar-usage")).toBe("fine");
  expect(found.getAttribute("aria-label")).toBe("Claude: 40% used, resets 3:40 PM");
  expect(found.getAttribute("aria-expanded")).toBe("false");
  expect(found.getAttribute("aria-controls")).toBeTruthy();
  expect(found.querySelector("[data-usage-ring=fine]")).not.toBeNull();
});

it("hides the ring in Simple while fine and shows it near the limit and at it", () => {
  expect(mount(true).innerHTML).toBe("");
  flushSync(() => root!.unmount());
  serve([claude(92)]);
  expect(ring(mount(true))?.getAttribute("data-sidebar-usage")).toBe("near");
  flushSync(() => root!.unmount());
  serve([claude(100, { blocked: true })]);
  expect(ring(mount(true))?.getAttribute("data-sidebar-usage")).toBe("out");
});

it("shows the selected bot's AI, else the most constrained AI", () => {
  serve([claude(40), go(95)]);
  expect(ring(mount(false))?.getAttribute("aria-label")).toContain("Claude: 40% used");
  flushSync(() => root!.unmount());
  fixture.state = { bots: [bot("scout", "other-ai")], selectedId: "scout" };
  expect(ring(mount(false))?.getAttribute("aria-label")).toContain("OpenCode: 95% used");
});

it("opens the card after a mouse hover, and a click toggles it", async () => {
  const found = ring(mount(false))!;
  flushSync(() => found.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "touch" })));
  await wait(HOVER_MS);
  expect(card()).toBeNull();
  flushSync(() => found.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })));
  await wait(HOVER_MS);
  expect(card()?.getAttribute("id")).toBe(found.getAttribute("aria-controls"));
  expect(found.getAttribute("aria-expanded")).toBe("true");
  flushSync(() => found.click());
  expect(card()).toBeNull();
  flushSync(() => found.click());
  expect(card()).not.toBeNull();
  expect(card()?.textContent).toContain("Claude usage");
});

it("closes the card on Escape and on a click outside, but not on a click inside it", async () => {
  const found = ring(mount(false))!;
  flushSync(() => found.click());
  expect(card()).not.toBeNull();
  flushSync(() => card()!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  await wait(10);
  expect(card()).not.toBeNull();
  flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
  await wait(10);
  expect(card()).toBeNull();
  flushSync(() => found.click());
  expect(card()).not.toBeNull();
  flushSync(() => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  await wait(10);
  expect(card()).toBeNull();
});

it("lists the Monthly window in the card", () => {
  serve([go(60)]);
  const found = ring(mount(false))!;
  flushSync(() => found.click());
  const row = card()!.querySelector("[data-usage-row=monthly]")!;
  expect(row.textContent).toContain("Monthly");
  expect(row.textContent).toContain("40% left");
});
