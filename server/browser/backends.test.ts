import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { LocalBackend } from "./backends.ts";
import type { ChromeProcess } from "./chrome/launch.ts";
import { ProcessRegistry } from "./chrome/processes.ts";
import { browserRoot, ensureProfile, profileDir } from "./chrome/profile.ts";
import { FAKE_IDENTITY, FakeChrome } from "./testing/fake-chrome.ts";

const folders: string[] = [];
afterAll(async () => { for (const folder of folders) await removeTempDir(folder); });

/** A LocalBackend on a fake Chrome per start, each cancelling its first navigation as Chrome for Testing on Windows can. */
function backend(platform: NodeJS.Platform) {
  const dataDir = mkdtempSync(join(tmpdir(), "seira-backends-test-"));
  folders.push(dataDir);
  const chromes: FakeChrome[] = [];
  const local = new LocalBackend({
    dataDir,
    host: "desktop",
    platform,
    binary: async () => ({ path: "/fake/chrome", identity: { ...FAKE_IDENTITY } }),
    screen: async () => ({ width: 1920, height: 1080, deviceScaleFactor: 1 }),
    egressPort: async () => null,
    launch: async () => {
      const chrome = new FakeChrome({ navigationErrors: ["net::ERR_ABORTED"] });
      chromes.push(chrome);
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => chrome.onClose(() => resolve({ code: 0, signal: null })));
      const launched: ChromeProcess = {
        pid: 1, argv: [], transport: chrome, version: { product: "Chrome/153.0.8010.12", userAgent: "", protocolVersion: "1.3", revision: "" },
        exited, output: () => "", close: async () => { chrome.exit(); return exited; }, kill: async () => { chrome.exit(); return exited; },
      };
      return launched;
    },
  });
  const open = () => local.open({ key: "bot:warm", mode: "headless", fresh: false, viewport: { width: 1280, height: 800 }, downloadDir: join(dataDir, "downloads") });
  return { open, chromes };
}

describe("a fresh profile's first navigation on Windows", () => {
  it("is taken by a page of our own in a tab of its own, so the bot's first page opens", async () => {
    const { open, chromes } = backend("win32");
    const opened = await open();
    const chrome = chromes[0]!;
    expect(chrome.sent.filter((sent) => sent.method === "Target.createTarget")).toHaveLength(1);
    expect(chrome.sent.filter((sent) => sent.method === "Target.closeTarget")).toHaveLength(1);
    const tabs = opened.browser.pages();
    expect(tabs).toHaveLength(1);
    expect(opened.browser.activePage).toBe(tabs[0]);
    await tabs[0]!.navigate("http://example.test/first");
    expect(tabs[0]!.url()).toBe("http://example.test/first");
    await opened.close();
  });

  it("is left to the bot on a profile that navigated before, and off Windows", async () => {
    const windows = backend("win32");
    await (await windows.open()).close();
    const again = await windows.open();
    expect(windows.chromes[1]!.sent.some((sent) => sent.method === "Target.createTarget" || sent.method === "Page.navigate")).toBe(false);
    await again.close();
    const mac = backend("darwin");
    const opened = await mac.open();
    expect(mac.chromes[0]!.sent.some((sent) => sent.method === "Target.createTarget" || sent.method === "Page.navigate")).toBe(false);
    await expect(opened.browser.pages()[0]!.navigate("http://example.test/first")).rejects.toThrow(/ERR_ABORTED/);
    await opened.close();
  });
});

describe("a local browser's profile folder", () => {
  it("is held from the sweep while Chrome starts, and let go when the start fails", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "seira-backends-test-"));
    folders.push(dataDir);
    const registry = new ProcessRegistry(browserRoot(dataDir));
    const dir = profileDir(dataDir, "temp:a");
    const held: boolean[] = [];
    const local = new LocalBackend({
      dataDir,
      host: "desktop",
      binary: async () => ({ path: "/fake/chrome", identity: { ...FAKE_IDENTITY } }),
      screen: async () => ({ width: 1920, height: 1080, deviceScaleFactor: 1 }),
      egressPort: async () => { held.push(registry.reserved(dir)); return null; },
      registry,
      launch: async () => { held.push(registry.reserved(dir)); throw new Error("Chrome did not start"); },
    });
    await expect(local.open({ key: "temp:a", mode: "headless", fresh: false, viewport: { width: 1280, height: 800 }, downloadDir: join(dataDir, "downloads") })).rejects.toThrow("Chrome did not start");
    expect(held).toEqual([true, true]);
    expect(registry.reserved(dir)).toBe(false);
  });
});

describe("a local browser's first open of a profile", () => {
  function seeded(seed: (key: string) => Promise<string | null>, { product = "Chrome/153.0.8010.12" } = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), "seira-backends-test-"));
    folders.push(dataDir);
    const log = vi.fn();
    const local = new LocalBackend({
      dataDir,
      host: "desktop",
      binary: async () => ({ path: "/fake/chrome", identity: { ...FAKE_IDENTITY, product } }),
      screen: async () => ({ width: 1920, height: 1080, deviceScaleFactor: 1 }),
      egressPort: async () => null,
      seed,
      log,
      launch: async () => {
        const chrome = new FakeChrome();
        const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => chrome.onClose(() => resolve({ code: 0, signal: null })));
        const launched: ChromeProcess = {
          pid: 1, argv: [], transport: chrome, version: { product, userAgent: "", protocolVersion: "1.3", revision: "" },
          exited, output: () => "", close: async () => { chrome.exit(); return exited; }, kill: async () => { chrome.exit(); return exited; },
        };
        return launched;
      },
    });
    const open = async (key: string) => (await local.open({ key, mode: "headless", fresh: false, viewport: { width: 1280, height: 800 }, downloadDir: join(dataDir, "downloads") })).close();
    return { dataDir, local, open, log };
  }

  function earlierProfile(dataDir: string, lastVersion?: string): string {
    const dir = join(dataDir, "earlier-profile");
    mkdirSync(join(dir, "Default"), { recursive: true });
    writeFileSync(join(dir, "Default", "Cookies"), "saved sign-in");
    writeFileSync(join(dir, "SingletonLock"), "lock");
    writeFileSync(join(dir, "DevToolsActivePort"), "9222");
    if (lastVersion) writeFileSync(join(dir, "Last Version"), lastVersion);
    return dir;
  }

  it("copies the earlier browser's profile before Chrome starts, and not again once the profile exists", async () => {
    let folder = "";
    const seed = vi.fn(async () => folder);
    const fx = seeded(seed);
    folder = earlierProfile(fx.dataDir, "152.0.1.1");
    await fx.open("bot:scout");
    const dir = profileDir(fx.dataDir, "bot:scout");
    expect(readFileSync(join(dir, "Default", "Cookies"), "utf8")).toBe("saved sign-in");
    expect(existsSync(join(dir, "SingletonLock"))).toBe(false);
    expect(existsSync(join(dir, "DevToolsActivePort"))).toBe(false);
    expect(existsSync(join(dir, "seira-profile.json"))).toBe(true);
    writeFileSync(join(dir, "Default", "Cookies"), "new sign-in");
    await fx.open("bot:scout");
    expect(seed).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(dir, "Default", "Cookies"), "utf8")).toBe("new sign-in");
  });

  it("copies into a shared profile as well", async () => {
    let folder = "";
    const fx = seeded(async () => folder);
    folder = earlierProfile(fx.dataDir);
    await fx.open("shared:work");
    expect(existsSync(join(profileDir(fx.dataDir, "shared:work"), "Default", "Cookies"))).toBe(true);
  });

  it("never copies into a temporary profile", async () => {
    const seed = vi.fn(async () => "/unused");
    const fx = seeded(seed);
    await fx.open("temp:guest-1");
    expect(seed).not.toHaveBeenCalled();
  });

  it("does not ask for a copy of a profile that has a record already", async () => {
    const seed = vi.fn(async () => "/unused");
    const fx = seeded(seed);
    ensureProfile(fx.dataDir, "bot:scout");
    await fx.open("bot:scout");
    expect(seed).not.toHaveBeenCalled();
  });

  it("opens an empty profile and logs one line when a newer Chrome last opened the earlier profile", async () => {
    let folder = "";
    const fx = seeded(async () => folder);
    folder = earlierProfile(fx.dataDir, "158.0.1.1");
    await fx.open("bot:scout");
    expect(existsSync(join(profileDir(fx.dataDir, "bot:scout"), "Default", "Cookies"))).toBe(false);
    expect(fx.log).toHaveBeenCalledTimes(1);
    expect(fx.log.mock.calls[0]![0]).toContain("newer Chrome");
  });

  it("opens an empty profile when there is nothing to copy", async () => {
    const fx = seeded(async () => null);
    await fx.open("bot:scout");
    expect(existsSync(join(profileDir(fx.dataDir, "bot:scout"), "seira-profile.json"))).toBe(true);
    expect(fx.log).not.toHaveBeenCalled();
  });

  it("opens the browser when finding or copying the earlier profile fails", async () => {
    const asking = seeded(async () => { throw new Error("could not close the earlier browser"); });
    await asking.open("bot:scout");
    expect(existsSync(join(profileDir(asking.dataDir, "bot:scout"), "seira-profile.json"))).toBe(true);
    expect(asking.log).toHaveBeenCalledTimes(1);
    expect(asking.log.mock.calls[0]![0]).toContain("could not close the earlier browser");
    const copying = seeded(async () => join(tmpdir(), "seira-no-such-profile-folder"));
    await copying.open("bot:scout");
    expect(existsSync(join(profileDir(copying.dataDir, "bot:scout"), "seira-profile.json"))).toBe(true);
    expect(copying.log).toHaveBeenCalledTimes(1);
  });
});
