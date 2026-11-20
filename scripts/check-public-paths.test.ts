import { describe, expect, it } from "vitest";

import { addedFromNameStatus, findPrivatePaths, PRIVATE_PATHS } from "./check-public-paths.mjs";

const blocked = (path: string) => findPrivatePaths([path]).map((found: { path: string }) => found.path);

describe("private paths", () => {
  it("blocks a new file under each private folder", () => {
    for (const path of [
      "docs/plans/x.md", "docs/superpowers/specs/x.md", "docs/specs/x.md", "docs/requirements/x.md",
      "internal/notes.md", ".tmpexp/run.json",
    ]) {
      expect(blocked(path), path).toEqual([path]);
    }
  });

  it("blocks backups, local files and secret files at any depth", () => {
    for (const path of [
      "src/app.ts.bak", "src/app.ts.bak1", "a/b.bak23", "AGENTS.local.md", "CLAUDE.local.md", "sub/AGENTS.local.md",
      "brand/.env.local", "x.local", ".leakcheck.local", ".dev.vars", ".dev.vars.production",
      "cloudflare/updates/.dev.vars", ".env", ".env.production", "server/.env",
    ]) {
      expect(blocked(path), path).toEqual([path]);
    }
  });

  it("gives every finding a reason", () => {
    for (const { reason } of findPrivatePaths(["docs/plans/x.md", "a.bak", "x.local", ".env"])) expect(reason).not.toBe("");
    expect(PRIVATE_PATHS.length).toBeGreaterThan(0);
  });

  it("passes the example files, the Vite entries and the preview pages", () => {
    for (const path of [
      ".env.example", ".env.local.example", ".dev.vars.example", ".dev.vars.production.example", "cloudflare/control-plane/.dev.vars.example", "index.html", "rail.html",
      "x-preview.html", "maus.ps1",
    ]) {
      expect(blocked(path), path).toEqual([]);
    }
  });

  it("passes a path that only contains a private word", () => {
    for (const path of [
      "src/plans/x.ts", "docs/plans.md", "docs/planning/x.md", "server/internal/x.ts", "docs/specs-guide.md", "src/environment.ts",
      "backup.ts", "src/x.bakery.ts", "docs/local-setup.md", "src/envelope.ts",
    ]) {
      expect(blocked(path), path).toEqual([]);
    }
  });
});

describe("added files from git", () => {
  it("lists added files and renames into a private path, and skips changes", () => {
    const out = ["A", "docs/plans/new.md", "M", "docs/plans/old.md", "R100", "src/a.ts", "internal/a.ts", "D", "x"].join("\0");
    expect(addedFromNameStatus(out)).toEqual(["docs/plans/new.md", "internal/a.ts"]);
  });

  it("lets a file move inside a private folder", () => {
    expect(addedFromNameStatus(["R90", "docs/plans/a.md", "docs/plans/b.md"].join("\0"))).toEqual([]);
  });
});
