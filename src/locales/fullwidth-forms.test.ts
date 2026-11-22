import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Only CJK fonts carry the fullwidth and halfwidth forms. A computer without one shows an empty box in their place. */
const FULLWIDTH = /[＀-￯]/;
const CJK = new Set(["ja", "ko", "zh", "zh-tw"]);
const DIR = new URL("./", import.meta.url);
const CATALOGS = readdirSync(DIR)
  .filter(file => file.endsWith(".json") && file !== "source-hashes.json")
  .map(file => file.slice(0, -".json".length))
  .filter(code => !CJK.has(code));

describe("fullwidth forms", () => {
  it("reads the English catalog", () => expect(CATALOGS).toContain("en"));

  it.each(CATALOGS)("%s uses no fullwidth or halfwidth form", code => {
    const catalog = JSON.parse(readFileSync(new URL(`${code}.json`, DIR), "utf8")) as Record<string, string>;
    const found = Object.entries(catalog).filter(([, text]) => FULLWIDTH.test(text)).map(([key]) => key);
    expect(found, "write + or the button's name instead of a fullwidth sign").toEqual([]);
  });
});
