import { themeRecipeSchema, THEME_IDEAS_COUNT, THEME_RECIPE_LIMITS, type ThemeIdeasRequest, type ThemeRecipe } from "../../shared/theme-ideas.ts";
import type { SideJobText } from "../side-jobs.ts";

export const THEME_IDEAS_TIMEOUT_MS = 45_000;
/** A fixed sentence the prompt always carries, so a test engine can answer it. */
export const THEME_IDEAS_MARKER = "Make colour themes for the Seira chat app.";

type Request = Pick<ThemeIdeasRequest, "words" | "brandColour" | "pictureColours" | "refine" | "base">;

export function themeIdeasPrompt(request: Request): string {
  const lines = [
    THEME_IDEAS_MARKER,
    `Reply with only a JSON array of exactly ${THEME_IDEAS_COUNT} different themes and nothing else.`,
    'Each theme is {"name": string, "description": string, "light": {"canvas": hex, "accent": hex}, "dark": {"canvas": hex, "accent": hex}}.',
    "Every colour is a hex colour like #1a2b3c. Write no CSS and no other keys.",
    `name: at most ${THEME_RECIPE_LIMITS.name} characters. description: one plain line of at most ${THEME_RECIPE_LIMITS.description} characters about how the theme feels.`,
    "canvas is the window's background: a light colour in light, a dark colour in dark. accent is the colour of buttons and highlights.",
    "Write name and description in the language of the person's words, or in English when there are none.",
  ];
  if (request.base && request.refine) {
    lines.push(
      `The person already has this theme: ${JSON.stringify(request.base)}`,
      `Give ${THEME_IDEAS_COUNT} small variations of it. Keep its idea and change only this: ${JSON.stringify(request.refine)}.`,
    );
  }
  if (request.words) lines.push(`The person describes the look they want: ${JSON.stringify(request.words)}`);
  if (request.brandColour) lines.push(`Build the themes around this brand colour: ${request.brandColour}`);
  if (request.pictureColours?.length) lines.push(`The person chose a picture. Its main colours, the most common first: ${request.pictureColours.join(", ")}. Make the themes feel like the picture.`);
  return lines.join("\n");
}

/** The last JSON array of objects in the reply, fences and prose around it ignored. */
function lastObjectArray(reply: string): unknown[] | null {
  const body = reply.replace(/```[A-Za-z]*/g, "");
  for (let start = body.lastIndexOf("["); start >= 0; start = start ? body.lastIndexOf("[", start - 1) : -1) {
    for (let end = body.indexOf("]", start); end >= 0; end = body.indexOf("]", end + 1)) {
      try {
        const value: unknown = JSON.parse(body.slice(start, end + 1));
        if (Array.isArray(value) && value.length && value.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) return value;
        break;
      } catch {
        continue;
      }
    }
  }
  return null;
}

const clip = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : value);

/** Up to three valid, different recipes; none when the reply holds no usable one. A name or line that is too long is cut, not dropped. */
export function parseThemeIdeas(reply: string): ThemeRecipe[] {
  const seen = new Set<string>();
  const recipes: ThemeRecipe[] = [];
  for (const item of lastObjectArray(reply) ?? []) {
    const raw = item as Record<string, unknown>;
    const parsed = themeRecipeSchema.safeParse({ ...raw, name: clip(raw.name, THEME_RECIPE_LIMITS.name), description: clip(raw.description, THEME_RECIPE_LIMITS.description) });
    if (!parsed.success) continue;
    const { name, light, dark } = parsed.data;
    const keys = [name.toLowerCase(), `${light.canvas}${light.accent}${dark.canvas}${dark.accent}`];
    if (keys.some((key) => seen.has(key))) continue;
    for (const key of keys) seen.add(key);
    recipes.push(parsed.data);
    if (recipes.length === THEME_IDEAS_COUNT) break;
  }
  return recipes;
}

export type ThemeIdeasOutcome = { recipes: ThemeRecipe[] } | { failed: true } | { noWriter: true };

/** Asks the writer for recipes. A reply with no usable theme, an error, a timeout or the person leaving all count as
 * failed: nothing is saved or worn. A `null` writer: no bot can write here. */
export async function makeThemeIdeas(writer: SideJobText | null, request: Request, signal?: AbortSignal): Promise<ThemeIdeasOutcome> {
  if (!writer) return { noWriter: true };
  try {
    const reply = await writer.generateText(themeIdeasPrompt(request), { timeoutMs: THEME_IDEAS_TIMEOUT_MS, signal: AbortSignal.any([AbortSignal.timeout(THEME_IDEAS_TIMEOUT_MS * 2), ...(signal ? [signal] : [])]) });
    const recipes = parseThemeIdeas(reply);
    return recipes.length ? { recipes } : { failed: true };
  } catch {
    return { failed: true };
  }
}
