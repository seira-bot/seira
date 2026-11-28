import { describe, expect, it } from "vitest";

import type { ThemeRecipe } from "../../shared/theme-ideas.ts";
import type { SideJobText } from "../side-jobs.ts";
import { makeThemeIdeas, parseThemeIdeas, themeIdeasPrompt, THEME_IDEAS_MARKER } from "./ideas.ts";

const recipe = (name: string, shade: string): ThemeRecipe => ({
  name, description: `${name} feels calm`,
  light: { canvas: `#f${shade}f${shade}f${shade}`, accent: "#b5532a" }, dark: { canvas: `#0${shade}0${shade}0${shade}`, accent: "#e0a070" },
});
const three = [recipe("Latte", "5"), recipe("Mocha", "6"), recipe("Espresso", "7")];

const writer = (reply: () => Promise<string> | string): SideJobText & { prompts: string[] } => {
  const prompts: string[] = [];
  return { via: "engine", prompts, generateText: async (prompt) => { prompts.push(prompt); return reply(); } };
};

describe("parseThemeIdeas", () => {
  it("reads a plain JSON array of three recipes", () => {
    expect(parseThemeIdeas(JSON.stringify(three))).toEqual(three);
  });

  it("reads the last array through fences and prose, and skips a bracket in the prose", () => {
    const reply = `Sure! Here you go [three of them]:\n\`\`\`json\n${JSON.stringify(three)}\n\`\`\`\nTell me [if] you want changes.`;
    expect(parseThemeIdeas(reply)).toEqual(three);
  });

  it("returns nothing for broken JSON, a non-array or an empty reply", () => {
    expect(parseThemeIdeas('[{"name": "Oops", "light": {')).toEqual([]);
    expect(parseThemeIdeas(JSON.stringify({ name: "One" }))).toEqual([]);
    expect(parseThemeIdeas("")).toEqual([]);
    expect(parseThemeIdeas('["a", "b"]')).toEqual([]);
  });

  it("drops invalid items and keeps the valid ones", () => {
    const bad = [{ name: "No colours" }, { ...three[1], light: { canvas: "red", accent: "#fff" } }, { ...three[2], css: "body{}" }, three[0]];
    expect(parseThemeIdeas(JSON.stringify(bad))).toEqual([three[0]]);
  });

  it("writes short hex colours in full and cuts a name or line that is too long", () => {
    const [one] = parseThemeIdeas(JSON.stringify([{ name: "N".repeat(60), description: "d".repeat(120), light: { canvas: "#FFF", accent: "#A1B" }, dark: { canvas: "#000", accent: "#0F0" } }]));
    expect(one!.name).toHaveLength(40);
    expect(one!.description).toHaveLength(90);
    expect(one!.light).toEqual({ canvas: "#ffffff", accent: "#aa11bb" });
  });

  it("drops a repeat by name or by colours and keeps at most three", () => {
    const more = [...three, recipe("Latte", "9"), { ...recipe("Twin", "5"), light: three[0]!.light, dark: three[0]!.dark }, recipe("Fourth", "8")];
    expect(parseThemeIdeas(JSON.stringify(more)).map((one) => one.name)).toEqual(["Latte", "Mocha", "Espresso"]);
  });
});

describe("themeIdeasPrompt", () => {
  it("carries the fixed marker and the person's words as data", () => {
    const prompt = themeIdeasPrompt({ words: 'warm "coffee" shop', brandColour: "#aa5500", pictureColours: ["#112233", "#445566"] });
    expect(prompt).toContain(THEME_IDEAS_MARKER);
    expect(prompt).toContain(JSON.stringify('warm "coffee" shop'));
    expect(prompt).toContain("#aa5500");
    expect(prompt).toContain("#112233, #445566");
  });

  it("asks to keep a base theme's idea and change only the asked quality", () => {
    const prompt = themeIdeasPrompt({ base: three[0]!, refine: "Darker" });
    expect(prompt).toContain(JSON.stringify(three[0]));
    expect(prompt).toContain("Keep its idea and change only this: \"Darker\"");
  });
});

describe("makeThemeIdeas", () => {
  it("answers with the recipes of a good reply", async () => {
    const asked = writer(() => JSON.stringify(three));
    expect(await makeThemeIdeas(asked, { words: "coffee" })).toEqual({ recipes: three });
    expect(asked.prompts[0]).toContain(THEME_IDEAS_MARKER);
  });

  it("answers with fewer than three when only some are valid", async () => {
    expect(await makeThemeIdeas(writer(() => JSON.stringify([three[0], { name: "Bad" }])), { words: "x" })).toEqual({ recipes: [three[0]] });
  });

  it("fails when no recipe is valid, the call throws or the person leaves", async () => {
    expect(await makeThemeIdeas(writer(() => "I could not."), { words: "x" })).toEqual({ failed: true });
    expect(await makeThemeIdeas(writer(() => { throw new Error("engine down"); }), { words: "x" })).toEqual({ failed: true });
    const gone = new AbortController();
    const slow: SideJobText = { via: "engine", generateText: (_prompt, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted")))) };
    const pending = makeThemeIdeas(slow, { words: "x" }, gone.signal);
    gone.abort();
    expect(await pending).toEqual({ failed: true });
  });

  it("hands the engine a 45 second wait and the person's signal", async () => {
    let seen: { timeoutMs?: number; signal?: AbortSignal } | undefined;
    await makeThemeIdeas({ via: "engine", generateText: async (_prompt, options) => { seen = options; return "[]"; } }, { words: "x" });
    expect(seen?.timeoutMs).toBe(45_000);
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses when no bot can write", async () => {
    expect(await makeThemeIdeas(null, { words: "x" })).toEqual({ noWriter: true });
  });
});
