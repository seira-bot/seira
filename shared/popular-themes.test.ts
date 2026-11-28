import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { contrast, parseHex, type Mode } from "../src/lib/theme/palette.ts";
import { themeColors } from "../src/lib/theme/tokens.ts";
import { POPULAR_THEMES, popularTheme } from "./popular-themes.ts";
import { THEME_ID, themeFileSchema } from "./theme.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MODES: readonly Mode[] = ["dark", "light"];
const ratio = (colors: Record<string, string | undefined>, ink: string, ground: string) => contrast(parseHex(colors[ink]!), parseHex(colors[ground]!));

describe("popular themes", () => {
  it("ships the ten approved themes with ids a saved theme can also use", () => {
    expect(POPULAR_THEMES.map((entry) => entry.name)).toEqual(["Catppuccin", "Tokyo Night", "Dracula", "One Dark", "Nord", "Gruvbox", "Rosé Pine", "Solarized", "Ayu", "Night Owl"]);
    for (const entry of POPULAR_THEMES) {
      expect(entry.id).toMatch(/^popular-[a-z0-9-]+$/);
      expect(entry.id).toMatch(THEME_ID);
      expect(popularTheme(entry.id)).toBe(entry);
    }
    expect(new Set(POPULAR_THEMES.map((entry) => entry.id)).size).toBe(10);
    expect(popularTheme("popular-nope")).toBeUndefined();
  });

  it("is valid theme files with a dark and a light variant that follow the person's choice", () => {
    for (const entry of POPULAR_THEMES) {
      const parsed = themeFileSchema.safeParse(entry.theme);
      expect(parsed.success, entry.id).toBe(true);
      expect(entry.theme.skin).toBe("system");
      expect(entry.theme.name).toBe(entry.name);
      for (const mode of MODES) {
        expect(entry.theme[mode]?.canvas, `${entry.id} ${mode}`).toMatch(/^#[0-9a-f]{6}$/);
        expect(entry.theme[mode]?.accent, `${entry.id} ${mode}`).toMatch(/^#[0-9a-f]{6}$/);
        expect(entry.variants[mode].length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps text legible on every surface in all 20 variants", () => {
    for (const entry of POPULAR_THEMES) {
      for (const mode of MODES) {
        const colors = themeColors(entry.theme, mode);
        const at = `${entry.id} ${mode}`;
        expect(ratio(colors, "ink", "app"), `${at} ink`).toBeGreaterThanOrEqual(12);
        for (const ground of ["app", "panel", "card"]) {
          expect(ratio(colors, "ink-secondary", ground), `${at} ink-secondary on ${ground}`).toBeGreaterThanOrEqual(4.5);
          expect(ratio(colors, "ink-tertiary", ground), `${at} ink-tertiary on ${ground}`).toBeGreaterThanOrEqual(4.5);
          expect(ratio(colors, "accent-text", ground), `${at} accent-text on ${ground}`).toBeGreaterThanOrEqual(4.5);
        }
        expect(ratio(colors, "accent-ink", "accent"), `${at} accent-ink`).toBeGreaterThanOrEqual(4.5);
        expect(ratio(colors, "bubble-user-ink", "bubble-user"), `${at} bubble`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps status colours legible as text on cards and menus, and their ink on their fills", () => {
    for (const entry of POPULAR_THEMES) {
      for (const mode of MODES) {
        const colors = themeColors(entry.theme, mode);
        const at = `${entry.id} ${mode}`;
        for (const status of ["success", "danger", "warning"]) {
          for (const ground of ["app", "card", "menu"]) expect(ratio(colors, status, ground), `${at} ${status} on ${ground}`).toBeGreaterThanOrEqual(4.5);
        }
        expect(ratio(colors, "success-ink", "success"), `${at} success-ink`).toBeGreaterThanOrEqual(4.5);
        expect(ratio(colors, "danger-ink", "danger"), `${at} danger-ink`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("carries the MIT notice and licence of each theme", () => {
    const notice = readFileSync(`${ROOT}NOTICE`, "utf8");
    for (const name of ["Catppuccin", "Tokyo Night", "Dracula", "One Dark", "Nord", "Gruvbox", "Rosé Pine", "Solarized", "Ayu", "Night Owl"]) expect(notice, name).toContain(name);
    for (const folder of ["catppuccin", "tokyo-night", "dracula", "one-dark", "nord", "gruvbox", "rose-pine", "solarized", "ayu", "night-owl"]) {
      expect(notice, folder).toContain(`third_party/${folder}/LICENSE`);
      expect(existsSync(`${ROOT}third_party/${folder}/LICENSE`), folder).toBe(true);
      expect(readFileSync(`${ROOT}third_party/${folder}/LICENSE`, "utf8"), folder).toContain("Permission is hereby granted, free of charge");
    }
  });
});
