import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import { seedingDir } from "./profile.ts";
import { removeStaleSeeding, seedProfile } from "./seed.ts";

const folders: string[] = [];
afterAll(async () => { for (const folder of folders) await removeTempDir(folder); });

function link(target: string, path: string): void {
  try { symlinkSync(target, path); } catch {}
}

function source(lastVersion?: string) {
  const root = mkdtempSync(join(tmpdir(), "seira-seed-test-"));
  folders.push(root);
  const dir = join(root, "agent-browser-profile");
  mkdirSync(join(dir, "Default", "Cache"), { recursive: true });
  mkdirSync(join(dir, "Default", "Local Storage"), { recursive: true });
  mkdirSync(join(dir, "Code Cache"), { recursive: true });
  mkdirSync(join(dir, "GPUCache"), { recursive: true });
  writeFileSync(join(dir, "Default", "Cookies"), "cookies");
  writeFileSync(join(dir, "Default", "Local Storage", "leveldb"), "storage");
  writeFileSync(join(dir, "Default", "Cache", "entry"), "cache");
  writeFileSync(join(dir, "Code Cache", "entry"), "cache");
  writeFileSync(join(dir, "GPUCache", "entry"), "cache");
  writeFileSync(join(dir, "SingletonLock"), "lock");
  writeFileSync(join(dir, "SingletonCookie"), "cookie");
  writeFileSync(join(dir, "DevToolsActivePort"), "9222");
  writeFileSync(join(dir, "Default", "SingletonLock"), "nested lock");
  link("/nonexistent/target", join(dir, "SingletonSocket"));
  link("/nonexistent/target", join(dir, "Default", "link"));
  if (lastVersion) writeFileSync(join(dir, "Last Version"), lastVersion);
  return { dir, target: join(root, "profiles", "new-profile") };
}

describe("seeding a profile from another browser's profile folder", () => {
  it("copies saved sign-ins and leaves out locks, the DevTools port file, caches and links", async () => {
    const { dir, target } = source("153.0.8010.12");
    expect(await seedProfile(dir, target, "155.0.8059.80")).toBe("copied");
    expect(readFileSync(join(target, "Default", "Cookies"), "utf8")).toBe("cookies");
    expect(readFileSync(join(target, "Default", "Local Storage", "leveldb"), "utf8")).toBe("storage");
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort", "Code Cache", "GPUCache", join("Default", "Cache"), join("Default", "SingletonLock"), join("Default", "link")]) {
      expect(existsSync(join(target, name)), name).toBe(false);
    }
    expect(existsSync(seedingDir(target))).toBe(false);
  });

  it("copies a folder with no Last Version file, and one an equal Chrome opened", async () => {
    const plain = source();
    expect(await seedProfile(plain.dir, plain.target, "155.0.8059.80")).toBe("copied");
    const equal = source("155.0.8059.80");
    expect(await seedProfile(equal.dir, equal.target, "155.0.8059.80")).toBe("copied");
  });

  it("does not copy a folder that a newer Chrome last opened", async () => {
    const { dir, target } = source("158.0.1.1");
    expect(await seedProfile(dir, target, "155.0.8059.80")).toBe("newer-chrome");
    expect(existsSync(target)).toBe(false);
  });

  it("does not copy over a folder that already holds files", async () => {
    const { dir, target } = source();
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "mine"), "kept");
    expect(await seedProfile(dir, target, "155.0.8059.80")).toBe("occupied");
    expect(readFileSync(join(target, "mine"), "utf8")).toBe("kept");
    expect(existsSync(join(target, "Default"))).toBe(false);
  });

  it("leaves no half profile when the source is missing", async () => {
    const { dir, target } = source();
    await expect(seedProfile(join(dir, "missing"), target, "155.0.8059.80")).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
    expect(existsSync(seedingDir(target))).toBe(false);
  });
});

describe("the copy a stopped process leaves behind", () => {
  function stale(root: string, name: string): string {
    const dir = join(root, "seeding", name);
    mkdirSync(join(dir, "Default"), { recursive: true });
    writeFileSync(join(dir, "Default", "Cookies"), "half a copy");
    return dir;
  }

  it("builds the copy in the one seeding folder under the browser root, never beside the profile", () => {
    expect(seedingDir(join("data", "browser", "profiles", "abc"))).toBe(join("data", "browser", "seeding", "abc"));
  });

  it("is removed at the next start, but a copy that is running now stays", () => {
    const { target } = source();
    const root = join(target, "..", "..");
    const left = stale(root, "left");
    const running = stale(root, "running");
    removeStaleSeeding(root, (profile) => profile === join(root, "profiles", "running"));
    expect(existsSync(left)).toBe(false);
    expect(existsSync(running)).toBe(true);
  });

  describe("the earlier layout, `<hash>.seeding` beside the profile", () => {
    const HASH = "0123456789abcdef01234567";
    const OTHER = "89abcdef0123456789abcdef";
    function beside(root: string, kind: string, name: string): string {
      const dir = join(root, kind, name);
      mkdirSync(join(dir, "Default"), { recursive: true });
      writeFileSync(join(dir, "Default", "Cookies"), "half a copy");
      return dir;
    }

    it("is removed at the next start, in profiles and in temp, and a copy that is running now stays", () => {
      const { target } = source();
      const root = join(target, "..", "..");
      const left = beside(root, "profiles", `${HASH}.seeding`);
      const temp = beside(root, "temp", `${HASH}.seeding`);
      const running = beside(root, "profiles", `${OTHER}.seeding`);
      removeStaleSeeding(root, (profile) => profile === join(root, "profiles", OTHER));
      expect(existsSync(left)).toBe(false);
      expect(existsSync(temp)).toBe(false);
      expect(existsSync(running)).toBe(true);
    });

    it("matches the exact old name only: a profile, a short name, a suffix and a folder of another kind stay", () => {
      const { target } = source();
      const root = join(target, "..", "..");
      const keep = [
        beside(root, "profiles", HASH),
        beside(root, "profiles", "abc.seeding"),
        beside(root, "profiles", `${HASH}.seeding.bak`),
        beside(root, "profiles", `${HASH}x.seeding`),
        beside(root, "profiles", `${HASH.toUpperCase()}.seeding`),
        beside(root, "profiles", `.${HASH}.seeding`),
        beside(root, "other", `${HASH}.seeding`),
      ];
      writeFileSync(join(root, "profiles", `${OTHER}.seeding.txt`), "a file");
      removeStaleSeeding(root, () => false);
      for (const dir of keep) expect(existsSync(dir), dir).toBe(true);
      expect(existsSync(join(root, "profiles", `${OTHER}.seeding.txt`))).toBe(true);
    });

    it("is cleaned together with the new layout in one pass", () => {
      const { target } = source();
      const root = join(target, "..", "..");
      const fresh = stale(root, "left");
      const old = beside(root, "profiles", `${HASH}.seeding`);
      removeStaleSeeding(root, () => false);
      expect(existsSync(fresh)).toBe(false);
      expect(existsSync(old)).toBe(false);
    });

    it("works when only the old layout exists and no seeding folder was ever made", () => {
      const { target } = source();
      const root = join(target, "..", "..");
      const old = beside(root, "profiles", `${HASH}.seeding`);
      expect(existsSync(join(root, "seeding"))).toBe(false);
      removeStaleSeeding(root, () => false);
      expect(existsSync(old)).toBe(false);
    });
  });

  it("does nothing when no copy was ever made", () => {
    const { target } = source();
    expect(() => removeStaleSeeding(join(target, "..", ".."), () => false)).not.toThrow();
  });

  it("does not change a copy that finishes after an earlier one was left behind", async () => {
    const { dir, target } = source();
    const left = stale(join(target, "..", ".."), "new-profile");
    expect(await seedProfile(dir, target, "155.0.8059.80")).toBe("copied");
    expect(existsSync(left)).toBe(false);
    expect(readFileSync(join(target, "Default", "Cookies"), "utf8")).toBe("cookies");
  });
});
