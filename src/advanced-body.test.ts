import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");

describe("the Advanced section body styles", () => {
  const css = read("./advanced-body.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = css.split("{").slice(0, -1).map((part) => part.split("}").pop()!.trim());

  it("reach only what sits inside an Advanced body", () => {
    expect(selectors.length).toBeGreaterThan(0);
    for (const group of selectors) for (const selector of group.split(",")) expect(selector.trim()).toMatch(/^\[data-advanced-body\]/);
  });

  it("are loaded with the app's styles", () => {
    expect(read("./styles.css")).toContain('@import "./advanced-body.css";');
  });
});
