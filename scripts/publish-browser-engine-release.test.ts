import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { engineReleaseArgs, ensureTag, main, parseArgs, resolveTag } from "./publish-browser-engine-release.mjs";

const TAG = "browser-engine-v0.36.0-seira.2";
const SHA = "c521eab".padEnd(40, "0");
const OTHER = "61d75f5".padEnd(40, "0");

describe("publish-browser-engine-release", () => {
  it("always passes --latest=false, --verify-tag and --target, and never --latest", () => {
    const args = engineReleaseArgs(TAG, ["a.exe", "provenance.json"], { target: SHA });
    expect(args).toContain("--latest=false");
    expect(args).toContain("--verify-tag");
    expect(args).not.toContain("--latest");
    expect(args[args.indexOf("--target") + 1]).toBe(SHA);
    expect(args.slice(0, 3)).toEqual(["release", "create", TAG]);
  });

  it("puts every flag before -- and every asset path after it, even a path that looks like an option", () => {
    const files = ["--latest", "-t", "--notes=x", "--repo=evil/x", "a.exe"];
    const args = engineReleaseArgs(TAG, files, { target: SHA });
    const end = args.indexOf("--");
    expect(args.slice(end + 1)).toEqual(files);
    expect(args.slice(0, end).filter((arg) => arg.startsWith("-"))).toEqual(["--repo", "--title", "--target", "--verify-tag", "--latest=false", "--notes"]);
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

  const REF = (type: string, sha: string) => ({ ok: true, body: JSON.stringify({ object: { type, sha } }) });
  const NOT_FOUND = { ok: false, status: 404, error: "gh: Not Found (HTTP 404)" };
  const quietly = <T,>(fn: () => T): T => {
    const quiet = console.error;
    console.error = () => {};
    try { return fn(); } finally { console.error = quiet; }
  };

  it("resolves the exact tag ref: a commit, an annotated tag, a confirmed 404, and every other failure as an error", () => {
    expect(resolveTag("o/r", TAG, () => REF("commit", SHA))).toEqual({ commit: SHA });
    expect(resolveTag("o/r", TAG, (args: string[]) => (args[0].includes("/git/tags/") ? REF("commit", OTHER) : REF("tag", SHA)))).toEqual({ commit: OTHER });
    expect(resolveTag("o/r", TAG, () => NOT_FOUND)).toEqual({ missing: true });
    for (const status of [401, 403, 500, 502, null]) expect(resolveTag("o/r", TAG, () => ({ ok: false, status, error: "boom" })), String(status)).toHaveProperty("error");
    expect(resolveTag("o/r", TAG, () => ({ ok: true, body: "not json" }))).toHaveProperty("error");
    expect(resolveTag("o/r", TAG, () => REF("tree", SHA))).toHaveProperty("error");
  });

  it("reads exactly repos/<repo>/git/ref/tags/<tag>", () => {
    const calls: string[][] = [];
    resolveTag("o/r", TAG, (args: string[]) => { calls.push(args); return NOT_FOUND; });
    expect(calls).toEqual([[`repos/o/r/git/ref/tags/${TAG}`]]);
  });

  it("stops when the tag already points at another commit, and never moves it", () => {
    const calls: string[][] = [];
    expect(ensureTag("o/r", TAG, SHA, (args: string[]) => { calls.push(args); return REF("commit", SHA); })).toBeNull();
    expect(ensureTag("o/r", TAG, SHA, () => REF("commit", OTHER))).toMatch(/never moved/);
    expect(calls.some((args) => args.includes("POST"))).toBe(false);
    const runs: string[][] = [];
    expect(quietly(() => main([TAG, "--target", SHA, "--", "a"], (args: string[]) => { runs.push(args); }, () => REF("commit", OTHER)))).toBe(1);
    expect(runs).toEqual([]);
  });

  it("stops on a lookup error that is not a confirmed 404, and creates and publishes nothing", () => {
    for (const status of [401, 403, 500, null]) {
      const calls: string[][] = [];
      const runs: string[][] = [];
      const api = (args: string[]) => { calls.push(args); return { ok: false, status, error: "boom" }; };
      expect(quietly(() => main([TAG, "--target", SHA, "--", "a"], (args: string[]) => { runs.push(args); }, api)), String(status)).toBe(1);
      expect(calls, String(status)).toHaveLength(1);
      expect(runs, String(status)).toEqual([]);
    }
  });

  it("creates a missing tag at the build commit without force, reads it again, and then publishes with --verify-tag", () => {
    const calls: string[][] = [];
    let made = false;
    const api = (args: string[]) => {
      calls.push(args);
      if (args.includes("POST")) { made = true; return { ok: true, body: "{}" }; }
      return made ? REF("commit", SHA) : NOT_FOUND;
    };
    const runs: string[][] = [];
    expect(main([TAG, "--target", SHA, "--", "a"], (args: string[]) => { runs.push(args); }, api)).toBe(0);
    expect(calls).toEqual([
      [`repos/seira-bot/seira/git/ref/tags/${TAG}`],
      ["-X", "POST", "repos/seira-bot/seira/git/refs", "-f", `ref=refs/tags/${TAG}`, "-f", `sha=${SHA}`],
      [`repos/seira-bot/seira/git/ref/tags/${TAG}`],
    ]);
    expect(calls.flat()).not.toContain("force=true");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain("--verify-tag");
  });

  it("stops when the ref cannot be created, for example because another run created it first", () => {
    const runs: string[][] = [];
    const api = (args: string[]) => (args.includes("POST") ? { ok: false, status: 422, error: "Reference already exists (HTTP 422)" } : NOT_FOUND);
    expect(quietly(() => main([TAG, "--target", SHA, "--", "a"], (args: string[]) => { runs.push(args); }, api))).toBe(1);
    expect(runs).toEqual([]);
    expect(ensureTag("o/r", TAG, SHA, api)).toMatch(/cannot create .*422/);
  });

  it("stops when the created tag cannot be read again, is still missing, or points at another commit", () => {
    const post = { ok: true, body: "{}" };
    expect(ensureTag("o/r", TAG, SHA, (args: string[]) => (args.includes("POST") ? post : NOT_FOUND))).toMatch(/still missing/);
    let made = false;
    expect(ensureTag("o/r", TAG, SHA, (args: string[]) => { if (args.includes("POST")) { made = true; return post; } return made ? REF("commit", OTHER) : NOT_FOUND; })).toMatch(/after it was created/);
    made = false;
    expect(ensureTag("o/r", TAG, SHA, (args: string[]) => { if (args.includes("POST")) { made = true; return post; } return made ? { ok: false, status: 500, error: "x" } : NOT_FOUND; })).toMatch(/cannot read/);
  });

  it("main exits 2 on wrong use, 1 when gh fails, 0 on success", () => {
    const exists = () => REF("commit", SHA);
    quietly(() => {
      expect(main(["v1.0.0", "--target", SHA, "--", "a"], () => {}, exists)).toBe(2);
      expect(main([TAG, "--", "a"], () => {}, exists)).toBe(2);
    });
    expect(main([TAG, "--target", SHA, "--", "a"], () => { throw new Error("x"); }, exists)).toBe(1);
    expect(main([TAG, "--target", SHA, "--", "a"], () => {}, exists)).toBe(0);
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
