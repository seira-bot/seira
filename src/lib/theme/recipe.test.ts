import { describe, expect, it } from "vitest";

import { themeFileSchema } from "../../../shared/theme";
import type { ThemeRecipe } from "../../../shared/theme-ideas";
import { accentPalette, canvasPalette, contrast, modeOf, parseHex, type Mode } from "./palette";
import { readableColours, recipeThemeFile } from "./recipe";

const ratio = (a: string | undefined, b: string | undefined) => contrast(parseHex(a!), parseHex(b!));

function expectReadable(side: { canvas: string; accent: string }, mode: Mode) {
  expect(modeOf(side.canvas)).toBe(mode);
  const surfaces = canvasPalette(side.canvas, mode);
  const colours = accentPalette(side.accent, mode, side.canvas);
  expect(ratio(surfaces.ink, surfaces.app)).toBeGreaterThanOrEqual(12);
  for (const role of ["app", "panel", "card"] as const) {
    expect(ratio(surfaces["ink-secondary"], surfaces[role])).toBeGreaterThanOrEqual(4.5);
    expect(ratio(colours["accent-text"], surfaces[role])).toBeGreaterThanOrEqual(4.5);
  }
  expect(ratio(colours["accent-ink"], colours.accent)).toBeGreaterThanOrEqual(4.5);
}

const HOSTILE: Array<[string, ThemeRecipe]> = [
  ["grey on grey", { name: "Grey", description: "", light: { canvas: "#808080", accent: "#8a8a8a" }, dark: { canvas: "#808080", accent: "#8a8a8a" } }],
  ["near-white accent on a light canvas", { name: "Paper", description: "", light: { canvas: "#ffffff", accent: "#fafafa" }, dark: { canvas: "#101010", accent: "#fefefe" } }],
  ["near-black accent on a dark canvas", { name: "Ink", description: "", light: { canvas: "#f4f1ea", accent: "#020202" }, dark: { canvas: "#0a0a0a", accent: "#050505" } }],
  ["mid tones swapped between modes", { name: "Swapped", description: "", light: { canvas: "#222244", accent: "#7777aa" }, dark: { canvas: "#ddddee", accent: "#777788" } }],
  ["saturated mid canvases", { name: "Loud", description: "", light: { canvas: "#ff00aa", accent: "#00ffcc" }, dark: { canvas: "#00aa55", accent: "#ffee00" } }],
  ["yellow on yellow", { name: "Sun", description: "", light: { canvas: "#ffe066", accent: "#ffd400" }, dark: { canvas: "#3a3000", accent: "#ffd400" } }],
];

describe("recipeThemeFile", () => {
  it.each(HOSTILE)("keeps every text role readable: %s", (_label, recipe) => {
    const file = recipeThemeFile(recipe);
    expectReadable(file.light as { canvas: string; accent: string }, "light");
    expectReadable(file.dark as { canvas: string; accent: string }, "dark");
  });

  it("makes a theme the store accepts that follows the window's choice", () => {
    const file = recipeThemeFile(HOSTILE[0]![1]);
    expect(themeFileSchema.safeParse(file).success).toBe(true);
    expect(file).toMatchObject({ name: "Grey", skin: "system" });
    expect(Object.keys(file).sort()).toEqual(["dark", "light", "name", "skin"]);
  });

  it("leaves colours that already read as they are", () => {
    const good = { canvas: "#fdf6e3", accent: "#b5532a" };
    expect(readableColours(good, "light")).toEqual(good);
    const night = { canvas: "#0b1020", accent: "#7aa2ff" };
    expect(readableColours(night, "dark")).toEqual(night);
  });
});
