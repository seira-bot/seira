import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import { seedProfile } from "./seed.ts";

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
    expect(existsSync(`${target}.seeding`)).toBe(false);
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
    expect(existsSync(`${target}.seeding`)).toBe(false);
  });
});
