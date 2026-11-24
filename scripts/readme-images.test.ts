import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const sources = [...readme.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]!);
const isRemote = (source: string) => /^https?:\/\//.test(source);
const hostOf = (source: string) => new URL(source).hostname;

describe("README images", () => {
  it("finds the images", () => {
    expect(sources.length).toBeGreaterThan(5);
  });

  // GitHub loads remote README images through its image proxy, which gives up after about 4 seconds.
  // A shields.io badge often needs longer, and the page then shows its alt text instead.
  it("loads no badge from shields.io", () => {
    expect(sources.filter((source) => isRemote(source) && hostOf(source) === "img.shields.io")).toEqual([]);
  });

  it("finds each local image in the repository", () => {
    for (const source of sources.filter((value) => !isRemote(value))) {
      expect(existsSync(new URL(`../${source}`, import.meta.url)), source).toBe(true);
    }
  });
});
