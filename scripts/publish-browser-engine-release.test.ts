import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { engineReleaseArgs, main } from "./publish-browser-engine-release.mjs";

describe("publish-browser-engine-release", () => {
  it("always passes --latest=false and never --latest", () => {
    const args = engineReleaseArgs("browser-engine-v0.36.0-seira.2", ["a.exe", "provenance.json"]);
    expect(args).toContain("--latest=false");
    expect(args).not.toContain("--latest");
    expect(args.slice(0, 5)).toEqual(["release", "create", "browser-engine-v0.36.0-seira.2", "a.exe", "provenance.json"]);
  });

  it("refuses an app tag and an empty file list", () => {
    expect(() => engineReleaseArgs("v0.1.192", ["a"])).toThrow(/browser-engine/);
    expect(() => engineReleaseArgs("browser-engine-v0.36.0-seira.2", [])).toThrow(/file/);
  });

  it("main exits 2 on wrong use, 1 when gh fails, 0 on success", () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      expect(main(["v1.0.0", "a"], () => {})).toBe(2);
    } finally {
      console.error = quiet;
    }
    expect(main(["browser-engine-v0.36.0-seira.2", "a"], () => { throw new Error("x"); })).toBe(1);
    expect(main(["browser-engine-v0.36.0-seira.2", "a"], () => {})).toBe(0);
  });

  it("the engine code never reads releases/latest", () => {
    const dir = join(__dirname, "..", "server");
    const files = readdirSync(dir).filter((name) => /^browser-engine.*\.ts$/.test(name) && !name.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) expect(readFileSync(join(dir, name), "utf8"), name).not.toMatch(/releases\/latest/);
  });

  it("no workflow or script creates an engine release without --latest=false", () => {
    for (const dir of [".github/workflows", "scripts"]) {
      for (const name of readdirSync(join(__dirname, "..", dir))) {
        if (!/\.(ya?ml|mjs|sh)$/.test(name) || name.includes("publish-browser-engine-release")) continue;
        const text = readFileSync(join(__dirname, "..", dir, name), "utf8");
        if (/gh release create[^\n]*browser-engine/.test(text)) expect(text, name).toContain("--latest=false");
      }
    }
  });
});
