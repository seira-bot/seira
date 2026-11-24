import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { engineReleaseArgs, main, parseArgs, tagProblem } from "./publish-browser-engine-release.mjs";

const TAG = "browser-engine-v0.36.0-seira.2";
const SHA = "c521eab".padEnd(40, "0");
const OTHER = "61d75f5".padEnd(40, "0");

describe("publish-browser-engine-release", () => {
  it("always passes --latest=false and --target, and never --latest", () => {
    const args = engineReleaseArgs(TAG, ["a.exe", "provenance.json"], { target: SHA });
    expect(args).toContain("--latest=false");
    expect(args).not.toContain("--latest");
    expect(args[args.indexOf("--target") + 1]).toBe(SHA);
    expect(args.slice(0, 3)).toEqual(["release", "create", TAG]);
  });

  it("puts every flag before -- and every asset path after it, even a path that looks like an option", () => {
    const files = ["--latest", "-t", "--notes=x", "--repo=evil/x", "a.exe"];
    const args = engineReleaseArgs(TAG, files, { target: SHA });
    const end = args.indexOf("--");
    expect(args.slice(end + 1)).toEqual(files);
    expect(args.slice(0, end).filter((arg) => arg.startsWith("-"))).toEqual(["--repo", "--title", "--target", "--latest=false", "--notes"]);
    expect(args.slice(0, end)).not.toContain("--latest");
  });

  it("requires the 40-character build commit", () => {
    expect(() => engineReleaseArgs(TAG, ["a"], {})).toThrow(/--target/);
    expect(() => engineReleaseArgs(TAG, ["a"], { target: "main" })).toThrow(/--target/);
    expect(() => engineReleaseArgs(TAG, ["a"], { target: "c521eab" })).toThrow(/--target/);
    expect(() => engineReleaseArgs(TAG, ["a"], { target: SHA.toUpperCase() })).toThrow(/--target/);
  });

  it("refuses an app tag, a bad repo and an empty file list", () => {
    expect(() => engineReleaseArgs("v0.1.192", ["a"], { target: SHA })).toThrow(/browser-engine/);
    expect(() => engineReleaseArgs(TAG, [], { target: SHA })).toThrow(/file/);
    expect(() => engineReleaseArgs(TAG, ["a"], { target: SHA, repo: "--x" })).toThrow(/--repo/);
  });

  it("reads flags before -- and takes everything after -- as a file", () => {
    expect(parseArgs([TAG, "--target", SHA, "--repo", "o/r", "--", "--target", "x.exe"])).toEqual({ tag: TAG, target: SHA, repo: "o/r", files: ["--target", "x.exe"] });
    expect(() => parseArgs([TAG, "--target", SHA, "a.exe"])).toThrow(/after --/);
    expect(() => parseArgs([TAG, "--bogus"])).toThrow(/unknown option/);
    expect(() => parseArgs([TAG, "--target"])).toThrow(/needs a value/);
  });

  it("stops when the tag already points at another commit, and never moves it", () => {
    expect(tagProblem(TAG, SHA, () => null)).toBeNull();
    expect(tagProblem(TAG, SHA, () => SHA)).toBeNull();
    expect(tagProblem(TAG, SHA, () => OTHER)).toMatch(/never moved/);
    const runs: string[][] = [];
    const quiet = console.error;
    console.error = () => {};
    try {
      expect(main([TAG, "--target", SHA, "--", "a"], (args: string[]) => { runs.push(args); }, () => OTHER)).toBe(1);
    } finally {
      console.error = quiet;
    }
    expect(runs).toEqual([]);
  });

  it("main exits 2 on wrong use, 1 when gh fails, 0 on success", () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      expect(main(["v1.0.0", "--target", SHA, "--", "a"], () => {}, () => null)).toBe(2);
      expect(main([TAG, "--", "a"], () => {}, () => null)).toBe(2);
    } finally {
      console.error = quiet;
    }
    expect(main([TAG, "--target", SHA, "--", "a"], () => { throw new Error("x"); }, () => null)).toBe(1);
    expect(main([TAG, "--target", SHA, "--", "a"], () => {}, () => null)).toBe(0);
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
