import type { ThemeRecipe } from "../../../shared/theme-ideas";
import type { ThemeFile } from "../../../shared/theme";
import { accentPalette, canvasPalette, contrast, modeOf, parseHex, type Mode } from "./palette";

type Rgb = readonly [number, number, number];

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

const toHex = (rgb: Rgb) => `#${rgb.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
const mixHex = (from: string, to: Rgb, amount: number): string => {
  const base = parseHex(from);
  return toHex([0, 1, 2].map((index) => base[index]! + (to[index]! - base[index]!) * amount) as unknown as Rgb);
};
const roleContrast = (a: string | undefined, b: string | undefined) => (a && b ? contrast(parseHex(a), parseHex(b)) : 0);

const INK_ON_CANVAS = 12;
const READABLE = 4.5;
const ACCENT_APART = 1.5;

function canvasReads(canvas: string, mode: Mode): boolean {
  if (modeOf(canvas) !== mode) return false;
  const palette = canvasPalette(canvas, mode);
  return roleContrast(palette.ink, palette.app) >= INK_ON_CANVAS && roleContrast(palette["ink-secondary"], palette.app) >= READABLE;
}

function accentReads(accent: string, canvas: string, mode: Mode): boolean {
  const surfaces = canvasPalette(canvas, mode);
  const colours = accentPalette(accent, mode, canvas);
  return (["app", "panel", "card"] as const).every((role) => roleContrast(colours["accent-text"], surfaces[role]) >= READABLE
    && roleContrast(surfaces["ink-secondary"], surfaces[role]) >= READABLE)
    && roleContrast(colours["accent-ink"], colours.accent) >= READABLE
    && roleContrast(colours.accent, canvas) >= ACCENT_APART;
}

/** The nearest colour to `start`, moving toward `target`, for which `ok` holds; the target itself when none does. */
function nudge(start: string, target: Rgb, ok: (colour: string) => boolean): string {
  for (let step = 0; step <= 20; step++) {
    const next = step === 0 ? start : mixHex(start, target, step / 20);
    if (ok(next)) return next;
  }
  return toHex(target);
}

/** A canvas and accent the app can paint in `mode` with every text role readable: the canvas is moved toward white (light)
 * or black (dark) until its text reaches the contrast the app asks for, then the accent until its text and its button
 * are readable and it stands apart from the canvas. Colours that already read are not changed. */
export function readableColours(colours: { canvas: string; accent: string }, mode: Mode): { canvas: string; accent: string } {
  const canvas = nudge(colours.canvas, mode === "light" ? WHITE : BLACK, (candidate) => canvasReads(candidate, mode));
  const accent = nudge(colours.accent, mode === "light" ? BLACK : WHITE, (candidate) => accentReads(candidate, canvas, mode));
  return { canvas, accent };
}

/** The theme a recipe makes: it follows the window's light or dark choice, and each side is made readable. */
export function recipeThemeFile(recipe: ThemeRecipe): ThemeFile {
  return {
    name: recipe.name,
    skin: "system",
    light: readableColours(recipe.light, "light"),
    dark: readableColours(recipe.dark, "dark"),
  };
}
