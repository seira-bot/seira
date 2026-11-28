import type { ThemeColorRole, ThemeFile } from "../../../shared/theme";
import { SKIN_MODE, THEME_SKINS, type SkinId } from "../skins";
import { accentPalette, canvasPalette, modeOf, type Mode } from "./palette";

export type ThemeLook = Pick<ThemeFile, "skin" | "canvas" | "accent" | "colors" | "light" | "dark">;

/** Whether the theme's light and dark variants follow the person's Light or dark choice. */
export function followsChoice(theme: ThemeLook): boolean {
  const plainSkin = !theme.skin || theme.skin === "system" || theme.skin === THEME_SKINS.light || theme.skin === THEME_SKINS.dark;
  return Boolean(theme.light && theme.dark) && plainSkin;
}

/** The mode a theme paints in when the person's own choice is `current`. */
export function themeMode(theme: ThemeLook, current: Mode): Mode {
  if (followsChoice(theme)) return current;
  if (theme.skin && theme.skin !== "system") return SKIN_MODE[theme.skin];
  return theme.canvas ? modeOf(theme.canvas) : current;
}

export function themeCanvas(theme: ThemeLook, mode: Mode): string | undefined {
  return theme[mode]?.canvas ?? (theme.canvas && modeOf(theme.canvas) === mode ? theme.canvas : undefined);
}

/** The colour roles a theme sets in `mode`: what its canvas and accent derive, then its own roles over them. */
export function themeColors(theme: ThemeLook, mode: Mode): Partial<Record<ThemeColorRole, string>> {
  const variant = theme[mode];
  const canvas = themeCanvas(theme, mode);
  const accent = variant?.accent ?? theme.accent;
  return {
    ...(canvas ? canvasPalette(canvas, mode) : {}),
    ...(accent ? accentPalette(accent, mode, canvas ?? (mode === "dark" ? "#121212" : "#ffffff")) : {}),
    ...theme.colors,
    ...variant?.colors,
  };
}

/** The built-in skin a theme sits on, when it pins one. */
export function themeSkin(theme: ThemeLook): SkinId | undefined {
  return theme.skin && theme.skin !== "system" && !followsChoice(theme) ? theme.skin : undefined;
}
