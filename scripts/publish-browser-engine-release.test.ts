import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { engineReleaseArgs, ensureTag, ensureTagProtection, main as realMain, parseArgs, resolveTag } from "./publish-browser-engine-release.mjs";

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

  // A fake ruleset API. `main` goes through `protectedApi`, so the older tests see a protected engine-tag namespace.
  const ruleApi = (include: string[], types = ["update", "deletion"], bypass: unknown = [], extra: Record<string, unknown> = {}) => (args: string[]) => {
    if (args[0].includes("/rulesets?")) return { ok: true, body: JSON.stringify([{ id: 7, target: "tag", enforcement: "active" }, { id: 8, target: "branch", enforcement: "active" }]) };
    if (args[0].endsWith("/rulesets/7")) return { ok: true, body: JSON.stringify({ id: 7, name: "browser engine tags", target: "tag", enforcement: "active", conditions: { ref_name: { include, exclude: [] } }, rules: types.map((type) => ({ type })), ...(bypass === "absent" ? {} : { bypass_actors: bypass }), ...extra }) };
    return { ok: false, status: 404, error: "unexpected call" };
  };
  const PROTECTED = ruleApi(["refs/tags/browser-engine-v*"]);
  const protectedApi = (api: (args: string[]) => unknown) => (args: string[]) => (args[0].includes("/rulesets") ? PROTECTED(args) : api(args));
  const main = (argv: string[], run?: (args: string[]) => void, api?: (args: string[]) => unknown) => realMain(argv, run, protectedApi(api as never) as never);

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

  it("rejects a release when only the app tag ruleset (refs/tags/v*) exists, even if the tag has the right commit: nonzero exit and no release command", () => {
    const runs: string[][] = [];
    const calls: string[][] = [];
    const api = (args: string[]) => { calls.push(args); return args[0].includes("/rulesets") ? ruleApi(["refs/tags/v*"])(args) : REF("commit", SHA); };
    expect(quietly(() => realMain([TAG, "--target", SHA, "--", "a"], (args: string[]) => { runs.push(args); }, api as never))).toBe(1);
    expect(runs).toEqual([]);
    expect(calls.some((args) => args.includes("POST"))).toBe(false);
    expect(ensureTagProtection("o/r", TAG, ruleApi(["refs/tags/v*"]) as never)).toMatch(/no active tag ruleset protects refs\/tags\/browser-engine-v/);
  });

  it("refuses before any tag or release write when an exclude pattern uses a bracket set that GitHub would apply (positive control: empty exclude passes)", () => {
    const withExclude = (exclude: string[]) => (args: string[]) => {
      if (!args[0].includes("/rulesets")) return NOT_FOUND;
      const r = ruleApi(["refs/tags/browser-engine-v*"])(args) as { ok: boolean; body?: string };
      if (!args[0].endsWith("/7")) return r;
      const b = JSON.parse(r.body as string); b.conditions.ref_name.exclude = exclude; return { ok: true, body: JSON.stringify(b) };
    };
    const runs: string[][] = []; const calls: string[][] = [];
    const bad = (args: string[]) => { calls.push(args); return withExclude(["refs/tags/browser-engine-[v]*"])(args); };
    expect(quietly(() => realMain([TAG, "--target", SHA, "--", "a"], (args: string[]) => { runs.push(args); }, bad as never))).toBe(1);
    expect(runs).toEqual([]);
    expect(calls.some((args) => args.includes("POST"))).toBe(false);
    expect(ensureTagProtection("o/r", TAG, withExclude([]) as never)).toBeNull();
  });

  it("refuses before any tag or release write for the `**/` exclude from the review, and when the list says active but the detail is disabled (positive control: exact include, empty exclude)", () => {
    const fixture = (patch: (detail: Record<string, any>) => void) => (args: string[]) => {
      if (!args[0].includes("/rulesets")) return NOT_FOUND;
      if (args[0].includes("/rulesets?")) return { ok: true, body: JSON.stringify([{ id: 42, target: "tag", enforcement: "active" }]) };
      const detail: Record<string, any> = { id: 42, name: "Engine tags fixture", target: "tag", enforcement: "active", conditions: { ref_name: { include: ["refs/tags/browser-engine-v*"], exclude: [] } }, rules: [{ type: "update" }, { type: "deletion" }], bypass_actors: [] };
      patch(detail);
      return { ok: true, body: JSON.stringify(detail) };
    };
    const refuses = (api: (args: string[]) => unknown) => {
      const runs: string[][] = []; const calls: string[][] = [];
      const spy = (args: string[]) => { calls.push(args); return api(args); };
      expect(quietly(() => realMain([TAG, "--target", SHA, "--", "a"], (args: string[]) => { runs.push(args); }, spy as never))).toBe(1);
      expect(runs).toEqual([]);
      expect(calls.some((args) => args.includes("POST"))).toBe(false);
    };
    refuses(fixture((d) => { d.conditions.ref_name.exclude = ["refs/tags/**/browser-engine-v*"]; }));
    refuses(fixture((d) => { d.enforcement = "disabled"; }));
    refuses(fixture((d) => { delete d.enforcement; }));
    refuses(fixture((d) => { delete d.conditions.ref_name.exclude; }));
    refuses(fixture((d) => { d.conditions.ref_name.include = ["refs/tags/browser-engine-v*", "refs/tags/x"]; }));
    refuses(fixture((d) => { d.target = "branch"; }));
    const runs: string[][] = [];
    const ok = (args: string[]) => (args[0].includes("/rulesets") ? fixture(() => {})(args) : REF("commit", SHA));
    expect(realMain([TAG, "--target", SHA, "--", "a"], (args: string[]) => { runs.push(args); }, ok as never)).toBe(0);
    expect(runs).toHaveLength(1);
  });

  it("accepts a ruleset that covers the engine tag with update and deletion rules and no bypass, with the same commit", () => {
    const runs: string[][] = [];
    const api = (args: string[]) => (args[0].includes("/rulesets") ? ruleApi(["refs/tags/browser-engine-v*"])(args) : REF("commit", SHA));
    expect(realMain([TAG, "--target", SHA, "--", "a"], (args: string[]) => { runs.push(args); }, api as never)).toBe(0);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain("--verify-tag");
    for (const pattern of ["~ALL", `refs/tags/${TAG}`, "refs/tags/browser-engine-v*-seira.*", "refs/tags/**"]) expect(ensureTagProtection("o/r", TAG, ruleApi([pattern]) as never), pattern).toMatch(/exactly include/);
  });

  it("rejects a ruleset that does not stop updates or deletions, or that lets someone bypass them", () => {
    const covered = ["refs/tags/browser-engine-v*"];
    expect(ensureTagProtection("o/r", TAG, ruleApi(covered, ["deletion"]) as never)).toMatch(/no update rule/);
    expect(ensureTagProtection("o/r", TAG, ruleApi(covered, ["update"]) as never)).toMatch(/no deletion rule/);
    expect(ensureTagProtection("o/r", TAG, ruleApi(covered, ["creation", "non_fast_forward"]) as never)).toMatch(/no update and deletion rule/);
    expect(ensureTagProtection("o/r", TAG, ruleApi(covered, ["update", "deletion"], [{ actor_id: 1, actor_type: "Team", bypass_mode: "always" }]) as never)).toMatch(/bypass actor/);
    const inactive = (args: string[]) => { const r = ruleApi(covered)(args) as { ok: boolean; body?: string }; if (!args[0].endsWith("/7")) return r; return { ok: true, body: JSON.stringify({ ...JSON.parse(r.body as string), enforcement: "evaluate" }) }; };
    expect(ensureTagProtection("o/r", TAG, inactive as never)).toMatch(/is not active/);
    const bracketExclude = (args: string[]) => { const r = ruleApi(covered)(args) as { ok: boolean; body?: string }; if (!args[0].endsWith("/7")) return r; const b = JSON.parse(r.body as string); b.conditions.ref_name.exclude = ["refs/tags/browser-engine-[v]*"]; return { ok: true, body: JSON.stringify(b) }; };
    expect(ensureTagProtection("o/r", TAG, bracketExclude as never)).toMatch(/exactly include/);
    const bracketInclude = ruleApi(["refs/tags/browser-engine-[v]*"]);
    expect(ensureTagProtection("o/r", TAG, bracketInclude as never)).toMatch(/exactly include/);
    expect(ensureTagProtection("o/r", TAG, ruleApi(covered) as never)).toBeNull();
    const excluded = ruleApi(covered, ["update", "deletion"], [], {});
    expect(ensureTagProtection("o/r", TAG, ((args: string[]) => { const r = excluded(args) as { ok: boolean; body?: string }; if (args[0].endsWith("/7")) { const b = JSON.parse(r.body as string); b.conditions.ref_name.exclude = [`refs/tags/${TAG}`]; return { ok: true, body: JSON.stringify(b) }; } return r; }) as never)).toMatch(/exactly include/);
  });

  it("fails closed when the rulesets or their bypass list cannot be read", () => {
    for (const status of [401, 403, 404, 500, null]) expect(ensureTagProtection("o/r", TAG, (() => ({ ok: false, status, error: "no access" })) as never), String(status)).toMatch(/cannot read the rulesets/);
    expect(ensureTagProtection("o/r", TAG, ruleApi(["refs/tags/browser-engine-v*"], ["update", "deletion"], "absent") as never)).toMatch(/bypass actors cannot be read/);
    const noDetail = (args: string[]) => (args[0].includes("/rulesets?") ? ruleApi([])(args) : { ok: false, status: 403, error: "forbidden" });
    expect(ensureTagProtection("o/r", TAG, noDetail as never)).toMatch(/cannot read ruleset 7/);
    expect(ensureTagProtection("o/r", TAG, (() => ({ ok: true, body: "{}" })) as never)).toMatch(/not a list/);
  });

  it("checks the protection before it creates a missing tag", () => {
    const calls: string[][] = [];
    const api = (args: string[]) => { calls.push(args); return args[0].includes("/rulesets") ? ruleApi(["refs/tags/v*"])(args) : NOT_FOUND; };
    expect(quietly(() => realMain([TAG, "--target", SHA, "--", "a"], () => {}, api as never))).toBe(1);
    expect(calls.some((args) => args.includes("POST") || args[0].includes("/git/ref/"))).toBe(false);
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
