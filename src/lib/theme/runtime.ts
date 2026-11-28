// The window's custom theme: colours painted over the skin's tokens, the theme's CSS after the app's own, kept in step
// with the server through `theme` frames. Every way back lives here, outside anything a theme's CSS can hide.
import { popularTheme } from "../../../shared/popular-themes";
import { SAFE_LOOK_PARAM, THEME_COLOR_ROLES, themeFileSchema, type ActiveTheme, type ThemeFile } from "../../../shared/theme";
import { readColorScheme } from "../color-scheme";
import { DEFAULT_SKIN_CHOICE, SKIN_IDS, applySkinChoice, readSkin, readSkinChoice, resolveSkin, subscribeSkin, THEME_SKINS, wearSkin, type SkinChoice } from "../skins";
import { modeOf } from "./palette";
import { followsChoice, themeCanvas, themeColors } from "./tokens";
import { applyThemeCss } from "./theme-css";

const CACHE_KEY = "seira-theme";
const SAFE_KEY = "seira-safe-look";
const PREVIEW_ID = "__preview";

export type WornTheme = { id: string; theme: ThemeFile };

let worn: WornTheme | null = null;
let preview: WornTheme | null = null;
let painted: string[] = [];
let painting = false;
const listeners = new Set<() => void>();

function storage(kind: "localStorage" | "sessionStorage"): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window[kind];
  } catch {
    return undefined;
  }
}

/** This page started without the custom theme (the address held ?safe-look); it stays off until the tab closes. */
export function safeLook(): boolean {
  try {
    if (typeof location !== "undefined" && new URLSearchParams(location.search).has(SAFE_LOOK_PARAM)) storage("sessionStorage")?.setItem(SAFE_KEY, "1");
    return storage("sessionStorage")?.getItem(SAFE_KEY) === "1";
  } catch {
    return false;
  }
}

export function wornTheme(): WornTheme | null {
  return worn;
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function clearPaint(root: HTMLElement): void {
  for (const property of painted) root.style.removeProperty(property);
  painted = [];
}

function paint(): void {
  if (typeof document === "undefined" || painting) return;
  painting = true;
  try {
    const root = document.documentElement;
    clearPaint(root);
    const shown = preview ?? worn;
    const theme = safeLook() ? null : shown?.theme;
    if (!theme) {
      delete root.dataset.theme;
      delete root.dataset.themeBubble;
      applyThemeCss("");
      wearSkin(readSkin());
      return;
    }
    const base: SkinChoice | undefined = followsChoice(theme) ? undefined : theme.skin ?? (theme.canvas ? THEME_SKINS[modeOf(theme.canvas)] : undefined);
    wearSkin(base ? resolveSkin(base) : readSkin());
    const mode = readColorScheme(root);
    const canvas = themeCanvas(theme, mode);
    const colors = themeColors(theme, mode);
    for (const role of THEME_COLOR_ROLES) {
      const value = colors[role];
      if (!value) continue;
      root.style.setProperty(`--color-${role}`, value);
      painted.push(`--color-${role}`);
    }
    if (canvas) {
      root.style.setProperty("--code-color-scheme", mode);
      painted.push("--code-color-scheme");
    }
    if (theme.font) {
      root.style.setProperty("--font-sans", theme.font);
      painted.push("--font-sans");
    }
    root.dataset.theme = shown!.id;
    if (colors["bubble-user"]) root.dataset.themeBubble = "";
    else delete root.dataset.themeBubble;
    applyThemeCss(theme.css ?? "");
  } finally {
    painting = false;
    for (const listener of listeners) listener();
  }
}

/** Wears `next` in this window, remembering it so the next start paints it before the server answers. */
export function wearTheme(next: WornTheme | null): void {
  worn = next;
  preview = null;
  try {
    if (next) storage("localStorage")?.setItem(CACHE_KEY, JSON.stringify(next));
    else storage("localStorage")?.removeItem(CACHE_KEY);
  } catch {
  }
  paint();
}

/** Paints `theme` in this window only, over what is worn, until it is ended or another theme is worn here. Nothing is
 * remembered for the next start and nothing reaches the server or the person's other windows. */
export function previewTheme(theme: ThemeFile | null): void {
  if (!theme && !preview) return;
  preview = theme ? { id: PREVIEW_ID, theme } : null;
  paint();
}

/** The theme painted by `previewTheme`, or null. The same object until it changes. */
export function previewingTheme(): ThemeFile | null {
  return preview?.theme ?? null;
}

function cachedTheme(): WornTheme | null {
  try {
    const raw = JSON.parse(storage("localStorage")?.getItem(CACHE_KEY) ?? "null") as { id?: unknown; theme?: unknown } | null;
    const theme = themeFileSchema.safeParse(raw?.theme);
    return typeof raw?.id === "string" && theme.success ? { id: raw.id, theme: theme.data } : null;
  } catch {
    return null;
  }
}

/** Asks the server which theme this person wears and wears it. A failed read keeps what is painted. */
export async function loadTheme(): Promise<void> {
  try {
    const res = await fetch("/api/themes/active", { headers: { accept: "application/json" } });
    if (!res.ok) return;
    const active = (await res.json()) as ActiveTheme;
    const theme = active.theme ? themeFileSchema.safeParse(active.theme) : null;
    wearTheme(active.id && theme?.success ? { id: active.id, theme: theme.data } : null);
  } catch {
  }
}

/** A `theme` frame: this person's theme changed in another window, in Settings or by a bot. */
export function applyThemeFrame(frame: { skin?: string }): void {
  previewTheme(null);
  const skin = frame.skin;
  if (skin === "system" || SKIN_IDS.includes(skin as (typeof SKIN_IDS)[number])) applySkinChoice(skin as SkinChoice);
  void loadTheme();
}

const wearOnServer = (id: string | null, skin?: SkinChoice) =>
  fetch("/api/themes/active", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, ...(skin ? { skin } : {}) }) })
    .then((res) => res.ok, () => false);

/** Takes the custom theme off for this person, here at once and on the server for their other windows. */
export function takeOffTheme(): void {
  if (!worn) return;
  wearTheme(null);
  void wearOnServer(null);
}

/** Wears one of the person's saved themes, here and in their other windows; false when the server refused. */
export async function chooseTheme(id: string | null, skin?: SkinChoice): Promise<boolean> {
  const done = await wearOnServer(id, skin);
  if (done) await loadTheme();
  return done;
}

/** Wears a theme file at once here, then in the person's other windows. A skin with its own effects (Pop, Halloween,
 * Aurora) would paint under the theme, so the skin goes back to following the computer; Light, Dark and System stay. */
export async function wearThemeFile(id: string, theme: ThemeFile): Promise<boolean> {
  const choice = readSkinChoice();
  const plain = choice === "system" || choice === THEME_SKINS.light || choice === THEME_SKINS.dark;
  if (!plain) applySkinChoice("system");
  wearTheme({ id, theme });
  const done = await chooseTheme(id, plain ? undefined : "system");
  if (!done) await loadTheme();
  return done;
}

/** Wears a popular theme here and in the person's other windows. */
export async function wearPopularTheme(id: string): Promise<boolean> {
  const entry = popularTheme(id);
  return entry ? wearThemeFile(id, entry.theme) : false;
}

/** The way back from any theme: drops it and wears the default skin, whatever the server says. */
export function resetLook(): void {
  applySkinChoice(DEFAULT_SKIN_CHOICE);
  wearTheme(null);
  void wearOnServer(null, DEFAULT_SKIN_CHOICE);
}

/** Cmd+Option+Shift+R on a Mac, Ctrl+Alt+Shift+R elsewhere. */
export const isResetLookKey = (event: Pick<KeyboardEvent, "code" | "altKey" | "shiftKey" | "metaKey" | "ctrlKey">) =>
  event.code === "KeyR" && event.altKey && event.shiftKey && (event.metaKey || event.ctrlKey);

/** Before first paint: wears the remembered theme and listens for the reset keys on the window itself, where no
 * stylesheet can hide them. */
export function startTheme(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("keydown", (event) => {
    if (!isResetLookKey(event)) return;
    event.preventDefault();
    event.stopPropagation();
    resetLook();
  }, { capture: true });
  subscribeSkin(paint);
  if (typeof matchMedia === "function") {
    try {
      matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paint);
    } catch {
    }
  }
  worn = cachedTheme();
  if (worn) paint();
}
