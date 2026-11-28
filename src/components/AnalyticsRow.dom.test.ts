// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import en from "@/locales/en.json";

vi.mock("posthog-js", () => ({ default: {} }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.resetModules();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllEnvs();
});

async function render(simple = false) {
  const { AnalyticsRow } = await import("./AnalyticsRow");
  await act(async () => root.render(createElement(AnalyticsRow, { simple })));
  return host.querySelector<HTMLButtonElement>('[role="switch"]');
}

it("shows the switch in a build without a key, with the counts-only text", async () => {
  vi.stubEnv("VITE_SEIRA_POSTHOG_TOKEN", "");
  const toggle = await render();
  expect(toggle?.getAttribute("aria-checked")).toBe("true");
  expect(host.textContent).toContain(en["settings.analytics.countsOnly"]);
  expect(host.textContent).not.toContain(en["settings.analytics.subtitle"]);
  expect(host.querySelector("a")?.textContent).toBe(en["settings.analytics.link"]);
});

it("uses the short counts-only text on the simple page", async () => {
  vi.stubEnv("VITE_SEIRA_POSTHOG_TOKEN", "");
  await render(true);
  expect(host.textContent).toContain(en["settings.simple.analyticsCountsOnly"]);
  expect(host.querySelector("a")?.textContent).toBe(en["settings.simple.analyticsLink"]);
});

it("turns the card count off in a build without a key", async () => {
  vi.stubEnv("VITE_SEIRA_POSTHOG_TOKEN", "");
  const toggle = await render();
  await act(async () => toggle!.click());
  expect(toggle!.getAttribute("aria-checked")).toBe("false");
  expect(localStorage.getItem("seira-analytics-opt-out")).toBe("1");
  const { usageAnalyticsChoice } = await import("@/lib/analytics");
  expect(usageAnalyticsChoice()).toBe(false);
});

it("starts off when the person already chose off", async () => {
  vi.stubEnv("VITE_SEIRA_POSTHOG_TOKEN", "");
  localStorage.setItem("seira-analytics-opt-out", "1");
  const toggle = await render();
  expect(toggle!.getAttribute("aria-checked")).toBe("false");
});

it("keeps the PostHog text in a build with a key", async () => {
  vi.stubEnv("VITE_SEIRA_POSTHOG_TOKEN", "phc_test_key");
  const toggle = await render();
  expect(toggle).not.toBeNull();
  expect(host.textContent).toContain(en["settings.analytics.subtitle"]);
  expect(host.textContent).not.toContain(en["settings.analytics.countsOnly"]);
});
