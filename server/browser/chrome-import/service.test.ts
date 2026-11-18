import { mkdtempSync, readdirSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ImportCookie, SignedInSites } from "../../browser-sites.ts";
import { ChromeImportError } from "./errors.ts";
import { createChromeImportService, type ChromeImportDeps } from "./service.ts";
import { FAKE_NOW_MS, FAKE_NOW_UNIX, makeFakeHome, writeFakeBrowser, type FakeCookie } from "./testing/fake-profile.ts";

const cleanup: string[] = [];
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(cookies: FakeCookie[], options: { version?: 17 | 18 | 23 | 24; secrets?: string[]; now?: () => number } = {}) {
  const home = makeFakeHome();
  const tmpRoot = mkdtempSync(join(tmpdir(), "seira-service-tmp-"));
  cleanup.push(home, tmpRoot);
  writeFakeBrowser(join(home, ".config", "google-chrome"), [{ cookies, version: options.version ?? 24 }]);
  const commands: string[] = [];
  const deps: ChromeImportDeps = {
    home, env: {}, platform: "linux", tmpRoot, now: options.now ?? (() => FAKE_NOW_MS),
    runCommand: async (file) => {
      commands.push(file);
      if (!options.secrets) throw new Error("locked");
      return options.secrets.map((secret) => `secret = ${secret}`).join("\n");
    },
  };
  const written: ImportCookie[][] = [];
  const write = async (cookies: ImportCookie[]): Promise<SignedInSites> => {
    written.push(cookies);
    return { running: false, sites: [{ site: "example.com", cookies: cookies.length, storage: 0 }] };
  };
  return { service: createChromeImportService(deps), home, tmpRoot, commands, written, write };
}

const base: FakeCookie[] = [
  { hostKey: ".example.com", name: "sid", value: "S1" },
  { hostKey: "shop.test", name: "tok", value: "S2" },
  { hostKey: ".okta.com", name: "idp", value: "S3" },
];

describe("the import service", () => {
  it("lists profiles, then sites with counts, labels and suggestions, and leaves no copy behind", async () => {
    const { service, tmpRoot } = setup(base);
    expect(await service.profiles()).toEqual([{ id: "chrome:Default", name: "Default", browserName: "Chrome", lastUsed: false }]);
    const listing = await service.sites("chrome:Default", "owner");
    expect(listing).toMatchObject({ profileName: "Default", browserName: "Chrome" });
    expect(listing.ticket).toMatch(/^[0-9a-f-]{36}$/u);
    expect(listing.sites.map((site) => ({ ...site })).sort((a, b) => a.site.localeCompare(b.site))).toEqual([
      { site: "example.com", cookies: 1, sensitive: null, suggested: true },
      { site: "okta.com", cookies: 1, sensitive: "identity", suggested: false },
      { site: "shop.test", cookies: 1, sensitive: null, suggested: true },
    ]);
    for (const site of listing.sites) expect(Object.keys(site).sort()).toEqual(["cookies", "sensitive", "site", "suggested"]);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it("answers 404 for an unknown profile", async () => {
    const { service } = setup(base);
    await expect(service.sites("chrome:Nope", "owner")).rejects.toMatchObject({ status: 404, message: "That browser profile is no longer available." });
  });

  it("answers 413 for a cookie database over 64 MiB and reads nothing", async () => {
    const { service, home } = setup(base);
    truncateSync(join(home, ".config", "google-chrome", "Default", "Network", "Cookies"), 64 * 1024 * 1024 + 1);
    await expect(service.sites("chrome:Default", "owner")).rejects.toMatchObject({ status: 413, message: "This Chrome profile is too large to import." });
  });

  it("imports only the chosen sites, reads no key before the selection checks out, and wipes", async () => {
    const { service, commands, written, write } = setup(base);
    const { ticket } = await service.sites("chrome:Default", "owner");
    const result = await service.run({ ticket, caller: "owner", sites: ["example.com"], write });
    expect(written).toHaveLength(1);
    expect(written[0]!.map((cookie) => [cookie.name, cookie.value, cookie.domain])).toEqual([["sid", "S1", ".example.com"]]);
    expect(result).toEqual({ imported: { sites: 1, cookies: 1 }, skipped: 0, running: false, sites: [{ site: "example.com", cookies: 1, storage: 0 }] });
    expect(commands).toHaveLength(1);
  });

  it("answers 409 for a missing, used, expired or foreign ticket and imports nothing", async () => {
    let now = FAKE_NOW_MS;
    const { service, commands, written, write } = setup(base, { now: () => now });
    const attempt = (ticket: string, caller = "owner") => service.run({ ticket, caller, sites: ["example.com"], write });
    await expect(attempt("")).rejects.toMatchObject({ status: 409, message: "This list of sites has expired. Open it again." });
    const used = (await service.sites("chrome:Default", "owner")).ticket;
    await attempt(used);
    await expect(attempt(used)).rejects.toMatchObject({ status: 409 });
    const foreign = (await service.sites("chrome:Default", "owner")).ticket;
    await expect(attempt(foreign, "intruder")).rejects.toMatchObject({ status: 409 });
    const old = (await service.sites("chrome:Default", "owner")).ticket;
    now += 5 * 60 * 1000;
    await expect(attempt(old)).rejects.toMatchObject({ status: 409 });
    expect(written).toHaveLength(1);
    expect(commands).toHaveLength(1);
  });

  it("answers 400 for a site that is not in the ticket, or no site, before touching any key", async () => {
    const { service, commands, written, write } = setup(base);
    for (const sites of [["evil.test"], ["example.com", "evil.test"], []]) {
      const { ticket } = await service.sites("chrome:Default", "owner");
      await expect(service.run({ ticket, caller: "owner", sites, write })).rejects.toMatchObject({ status: 400, message: "Choose sites from the list." });
    }
    expect(commands).toEqual([]);
    expect(written).toEqual([]);
  });

  it("decrypts only the rows of the chosen hosts", async () => {
    const { service, write } = setup([
      { hostKey: ".example.com", name: "ok", value: "A" },
      { hostKey: "other.test", name: "poison", value: "B", scheme: "unknown" },
    ]);
    const { ticket } = await service.sites("chrome:Default", "owner");
    const result = await service.run({ ticket, caller: "owner", sites: ["example.com"], write });
    expect(result.skipped).toBe(0);
  });

  it("counts expired and unreadable cookies as skipped", async () => {
    const { service, write } = setup([
      { hostKey: ".example.com", name: "ok", value: "A" },
      { hostKey: ".example.com", name: "bad", value: "B", scheme: "unknown" },
      { hostKey: ".example.com", name: "late", value: "C", expiresUnix: FAKE_NOW_UNIX + 10 },
    ]);
    const { ticket } = await service.sites("chrome:Default", "owner");
    let later = false;
    const result = await service.run({ ticket, caller: "owner", sites: ["example.com"], write: async (cookies) => { later = true; return write(cookies); } });
    expect(later).toBe(true);
    expect(result).toMatchObject({ imported: { sites: 1, cookies: 2 }, skipped: 1 });
  });

  it("answers 503 and writes nothing when the password store gives no key and every value fails", async () => {
    const { service, written, write } = setup([{ hostKey: ".example.com", name: "a", value: "A", scheme: "v11", password: "unknown-ring" }]);
    const { ticket } = await service.sites("chrome:Default", "owner");
    const error = await service.run({ ticket, caller: "owner", sites: ["example.com"], write }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChromeImportError);
    expect(error).toMatchObject({ status: 503, message: "Seira could not open Chrome's saved logins. Unlock your computer's password store, then try again." });
    expect(written).toEqual([]);
  });

  it("opens v11 values with the password store's secret", async () => {
    const { service, write, written } = setup([{ hostKey: ".example.com", name: "a", value: "A", scheme: "v11", password: "ring" }], { secrets: ["ring"] });
    const { ticket } = await service.sites("chrome:Default", "owner");
    await service.run({ ticket, caller: "owner", sites: ["example.com"], write });
    expect(written[0]!.map((cookie) => cookie.value)).toEqual(["A"]);
  });
});
