// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const labels = vi.hoisted(() => ({ drawn: 0 }));
vi.mock("@/lib/transcript-derivations", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/transcript-derivations")>();
  return { ...original, dayLabel: (...args: Parameters<typeof original.dayLabel>) => { labels.drawn++; return original.dayLabel(...args); } };
});

const { DaySeparator } = await import("./DaySeparator");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DAY = 24 * 60 * 60 * 1000;
const at = new Date(2026, 10, 10, 9, 30).getTime();

let root: Root;
let host: HTMLElement;
const show = (props: { at: number; today: number; simple?: boolean }) =>
  act(async () => { root.render(createElement(DaySeparator, props)); });

beforeEach(() => {
  labels.drawn = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("DaySeparator", () => {
  it("does not draw again for equal props, and draws again for a new day", async () => {
    await show({ at, today: at });
    expect(labels.drawn).toBe(1);
    expect(host.textContent).toContain(":");
    await show({ at, today: at });
    expect(labels.drawn).toBe(1);
    await show({ at, today: at + 2 * DAY });
    expect(labels.drawn).toBe(2);
    await show({ at, today: at + 2 * DAY, simple: true });
    expect(labels.drawn).toBe(3);
  });
});
