import { z } from "zod";

export const THEME_IDEAS_PATH = "/api/themes/ideas";
export const THEME_IDEAS_COUNT = 3;
export const THEME_RECIPE_LIMITS = { name: 40, description: 90, words: 600, refine: 300, pictureColours: 8 } as const;

const hex = z.string().trim().regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i, "a hex colour such as #1a2b3c")
  .transform((value) => {
    const digits = value.slice(1).toLowerCase();
    return `#${digits.length === 3 ? [...digits].map((digit) => digit + digit).join("") : digits}`;
  });
const pair = z.object({ canvas: hex, accent: hex }).strict();

/** What the bot writes for one theme: a name, one line about it, and the two colours that drive a light and a dark
 * version. It never holds CSS; `recipeThemeFile` in src/lib/theme/recipe.ts turns it into a ThemeFile. */
export const themeRecipeSchema = z.object({
  name: z.string().trim().min(1).max(THEME_RECIPE_LIMITS.name),
  description: z.string().trim().max(THEME_RECIPE_LIMITS.description).default(""),
  light: pair,
  dark: pair,
}).strict();
export type ThemeRecipe = z.infer<typeof themeRecipeSchema>;

/** POST /api/themes/ideas. `botId`: the bot that writes (absent: the person's Seira). One of `words`, `brandColour` or
 * `pictureColours` is required, or `refine` with `base`. `pictureColours` are the main colours of a picture, most common
 * first; the picture itself never leaves the window. */
export const themeIdeasRequestSchema = z.object({
  botId: z.string().trim().min(1).max(120).optional(),
  words: z.string().trim().min(1).max(THEME_RECIPE_LIMITS.words).optional(),
  brandColour: hex.optional(),
  pictureColours: z.array(hex).min(1).max(THEME_RECIPE_LIMITS.pictureColours).optional(),
  refine: z.string().trim().min(1).max(THEME_RECIPE_LIMITS.refine).optional(),
  base: themeRecipeSchema.optional(),
}).strict().refine(
  (request) => Boolean(request.words || request.brandColour || request.pictureColours || (request.refine && request.base)),
  "Say what look you want.",
);
export type ThemeIdeasRequest = z.input<typeof themeIdeasRequestSchema>;

/** 200: one to three recipes. */
export interface ThemeIdeasReply {
  recipes: ThemeRecipe[];
}
/** Any other answer. `failed` (502): the bot's reply held no usable theme, took too long or could not be asked; nothing
 * changed. `no-writer` (409): no bot can write one-off text here. */
export interface ThemeIdeasFailure {
  error: string;
  reason: "failed" | "no-writer";
}
