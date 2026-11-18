import { pbkdf2Sync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ImportCookie } from "../../browser-sites.ts";
import { createChromeImportService } from "./service.ts";
import { FAKE_NOW_MS, makeFakeHome, writeFakeBrowser } from "./testing/fake-profile.ts";

const cleanup: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const VALUE_ONE = "cookie-value-7f3a9c1e";
const VALUE_TWO = "cookie-value-b84d02aa";
const PASSWORD = "keyring-password-Zq81xw";

describe("secrets stay out of logs and responses", () => {
  it("prints nothing with a cookie value, password or derived key during a full import, and returns no cookie details from sites()", async () => {
    const home = makeFakeHome();
    const tmpRoot = mkdtempSync(join(tmpdir(), "seira-leak-tmp-"));
    cleanup.push(home, tmpRoot);
    writeFakeBrowser(join(home, ".config", "google-chrome"), [{ cookies: [
      { hostKey: ".example.com", name: "session_token_name", value: VALUE_ONE },
      { hostKey: "www.example.com", name: "second_name", value: VALUE_TWO, scheme: "v11", password: PASSWORD },
    ] }]);
    const printed: string[] = [];
    const record = (...parts: unknown[]) => { printed.push(parts.map(String).join(" ")); };
    for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) vi.spyOn(console, method).mockImplementation(record);
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => { record(chunk); return true; }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => { record(chunk); return true; }) as typeof process.stderr.write);

    const service = createChromeImportService({
      home, env: {}, platform: "linux", tmpRoot, now: () => FAKE_NOW_MS,
      runCommand: async () => `secret = ${PASSWORD}\n`,
    });
    const listing = await service.sites("chrome:Default", "owner");
    const listingJson = JSON.stringify(listing);
    for (const forbidden of ["session_token_name", "second_name", VALUE_ONE, VALUE_TWO, "www.example.com", '".example.com"']) expect(listingJson).not.toContain(forbidden);

    let received: ImportCookie[] = [];
    const result = await service.run({ ticket: listing.ticket, caller: "owner", sites: ["example.com"], write: async (cookies) => { received = cookies; return { running: false, sites: [] }; } });
    expect(received.map((cookie) => cookie.value).sort()).toEqual([VALUE_ONE, VALUE_TWO]);
    const resultJson = JSON.stringify(result);
    for (const forbidden of [VALUE_ONE, VALUE_TWO, PASSWORD, "session_token_name"]) expect(resultJson).not.toContain(forbidden);

    const keyHex = [pbkdf2Sync(PASSWORD, "saltysalt", 1, 16, "sha1"), pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1")].flatMap((key) => [key.toString("hex"), key.toString("base64")]);
    const output = printed.join("\n");
    for (const forbidden of [VALUE_ONE, VALUE_TWO, PASSWORD, "session_token_name", ...keyHex]) expect(output).not.toContain(forbidden);
  });
});
