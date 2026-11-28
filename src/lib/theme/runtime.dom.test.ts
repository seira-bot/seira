// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ThemeFile } from "../../../shared/theme";

const values = new Map<string, string>();

beforeEach(() => {
  values.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.skin;
  document.documentElement.removeAttribute("style");
});

// The real skins set --code-color-scheme per skin; this stands in for them so paint() reads the worn skin's mode.
const skinModes = document.createElement("style");
skinModes.textContent = ':root[data-skin="daylight"] { --code-color-scheme: light; } :root[data-skin="midnight"] { --code-color-scheme: dark; }';
document.head.append(skinModes);

async function wear(theme: ThemeFile, skinChoice: string) {
  values.set("seira-skin", skinChoice);
  const runtime = await import("./runtime");
  runtime.wearTheme({ id: "repro", theme });
  return document.documentElement.dataset.skin;
}

const appColor = () => document.documentElement.style.getPropertyValue("--color-app");

const bothModes = { light: { canvas: "#ffffff", accent: "#d97757" }, dark: { canvas: "#121212", accent: "#d97757" } };

it("follows the person's Light or dark choice when the theme has both a light and a dark block", async () => {
  expect(await wear({ name: "Repro", skin: "system", ...bothModes }, "midnight")).toBe("midnight");
  expect(appColor()).toBe("#121212");
  expect(await wear({ name: "Repro", skin: "midnight", ...bothModes }, "daylight")).toBe("daylight");
  expect(appColor()).toBe("#ffffff");
  expect(await wear({ name: "Repro", canvas: "#121212", ...bothModes }, "daylight")).toBe("daylight");
  expect(appColor()).toBe("#ffffff");
});

it("still wears the theme's own skin when it has no block for the other mode", async () => {
  expect(await wear({ name: "Night", skin: "midnight", dark: bothModes.dark }, "daylight")).toBe("midnight");
  expect(await wear({ name: "Night", canvas: "#121212" }, "daylight")).toBe("midnight");
  expect(await wear({ name: "Plain", accent: "#d97757" }, "midnight")).toBe("midnight");
  expect(await wear({ name: "Spooky", skin: "halloween", ...bothModes }, "daylight")).toBe("halloween");
});

it("follows the system's light or dark change while a theme with both blocks is worn", async () => {
  let dark = true;
  const onChange = new Set<() => void>();
  vi.stubGlobal("matchMedia", () => ({
    get matches() { return dark; },
    addEventListener: (_type: string, listener: () => void) => { onChange.add(listener); },
    removeEventListener: (_type: string, listener: () => void) => { onChange.delete(listener); },
  }));
  values.set("seira-theme", JSON.stringify({ id: "repro", theme: { name: "Repro", skin: "system", ...bothModes } }));
  const runtime = await import("./runtime");
  const skins = await import("../skins");
  runtime.startTheme();
  skins.applySkinChoice("system");
  expect(document.documentElement.dataset.skin).toBe("midnight");
  expect(appColor()).toBe("#121212");
  for (const [nowDark, skin, canvas] of [[false, "daylight", "#ffffff"], [true, "midnight", "#121212"]] as const) {
    dark = nowDark;
    for (const listener of onChange) listener();
    expect(document.documentElement.dataset.skin).toBe(skin);
    expect(appColor()).toBe(canvas);
  }
});

it("marks the window while a theme sets its own bubble colour, so the Daylight inversion stays out of it", async () => {
  await wear({ name: "Repro", skin: "system", ...bothModes }, "daylight");
  expect(document.documentElement.dataset.themeBubble).toBe("");
  await wear({ name: "Plain", css: "a { color: red }" }, "daylight");
  expect(document.documentElement.dataset.themeBubble).toBeUndefined();
});

it("puts a popular theme on at once, and moves a skin with effects back to following the computer", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    return { ok: true, json: async () => ({ id: null, theme: null }) };
  });
  values.set("seira-skin", "pop");
  const runtime = await import("./runtime");
  expect(await runtime.wearPopularTheme("popular-dracula")).toBe(true);
  expect(values.get("seira-skin")).toBe("system");
  expect(calls[0]).toEqual({ url: "/api/themes/active", body: { id: "popular-dracula", skin: "system" } });
  values.set("seira-skin", "daylight");
  expect(await runtime.wearPopularTheme("popular-nord")).toBe(true);
  expect(values.get("seira-skin")).toBe("daylight");
  expect(calls.find((call) => (call.body as { id?: string } | undefined)?.id === "popular-nord")?.body).toEqual({ id: "popular-nord" });
  expect(await runtime.wearPopularTheme("popular-nope")).toBe(false);
});
