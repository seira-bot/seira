import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readCookieRows, readHostSummaries } from "./cookie-db.ts";
import { FAKE_NOW_UNIX, writeFakeBrowser, type FakeProfileSpec } from "./testing/fake-profile.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function database(spec: Partial<FakeProfileSpec>) {
  const root = mkdtempSync(join(tmpdir(), "seira-cookie-db-"));
  const tmpRoot = mkdtempSync(join(tmpdir(), "seira-cookie-tmp-"));
  dirs.push(root, tmpRoot);
  writeFakeBrowser(join(root, "browser"), [{ cookies: [], ...spec }]);
  return { path: join(root, "browser", "Default", "Network", "Cookies"), tmpRoot };
}

const cookies = [
  { hostKey: ".example.com", name: "sid", value: "SECRET-1", lastAccessUnix: FAKE_NOW_UNIX - 100 },
  { hostKey: ".example.com", name: "pref", value: "SECRET-2", httpOnly: false, lastAccessUnix: FAKE_NOW_UNIX - 500 },
  { hostKey: "shop.test", name: "t", value: "SECRET-3", expiresUnix: null, secure: false },
  { hostKey: "old.test", name: "gone", value: "SECRET-4", expiresUnix: FAKE_NOW_UNIX - 10 },
  { hostKey: ".partitioned.test", name: "chips", value: "SECRET-5", topFrameSiteKey: "https://other.test" },
];

describe("reading a cookie database from a private copy", () => {
  for (const version of [18, 23, 24] as const) {
    it(`summarises hosts without cookie contents, schema version ${version}`, () => {
      const { path, tmpRoot } = database({ version, cookies });
      const summaries = readHostSummaries(path, FAKE_NOW_UNIX, { tmpRoot });
      expect(summaries.sort((a, b) => a.hostKey.localeCompare(b.hostKey))).toEqual([
        { hostKey: ".example.com", cookieCount: 2, hasAuthShaped: true, lastAccess: FAKE_NOW_UNIX - 100 },
        { hostKey: "shop.test", cookieCount: 1, hasAuthShaped: false, lastAccess: FAKE_NOW_UNIX - 3600 },
      ]);
      expect(JSON.stringify(summaries)).not.toMatch(/SECRET/u);
    });
  }

  it("reads a schema without the partition column", () => {
    const { path, tmpRoot } = database({ version: 17, cookies });
    expect(readHostSummaries(path, FAKE_NOW_UNIX, { tmpRoot }).map((summary) => summary.hostKey).sort()).toEqual([".example.com", ".partitioned.test", "shop.test"]);
  });

  it("returns full rows only for the given host keys, with session cookies as null", () => {
    const { path, tmpRoot } = database({ version: 24, cookies });
    const { version, rows } = readCookieRows(path, ["shop.test"], FAKE_NOW_UNIX, { tmpRoot });
    expect(version).toBe(24);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hostKey: "shop.test", name: "t", path: "/", expiresUnix: null, secure: false, httpOnly: true, sameSite: -1 });
    expect(rows[0]!.encryptedValue.subarray(0, 3).toString()).toBe("v10");
  });

  it("converts expiry times past 2^53 microseconds without losing seconds", () => {
    const { path, tmpRoot } = database({ cookies: [{ hostKey: "a.test", name: "n", value: "v", expiresUnix: FAKE_NOW_UNIX + 12_345 }] });
    expect(readCookieRows(path, ["a.test"], FAKE_NOW_UNIX, { tmpRoot }).rows[0]!.expiresUnix).toBe(FAKE_NOW_UNIX + 12_345);
  });

  it("works from a copy with mode 600 in a folder with mode 700, and removes it before answering", () => {
    const { path, tmpRoot } = database({ cookies, withWal: true });
    const seen: Array<{ directory: number; files: Array<[string, number]> }> = [];
    readHostSummaries(path, FAKE_NOW_UNIX, {
      tmpRoot,
      onCopy: (directory) => seen.push({
        directory: statSync(directory).mode & 0o777,
        files: readdirSync(directory).sort().map((name) => [name, statSync(join(directory, name)).mode & 0o777]),
      }),
    });
    expect(seen).toEqual([{ directory: 0o700, files: [["Cookies", 0o600], ["Cookies-wal", 0o600]] }]);
    expect(readdirSync(tmpRoot)).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  it("removes the copy when the database is unreadable", () => {
    const { path, tmpRoot } = database({ cookies });
    rmSync(path);
    expect(() => readHostSummaries(path, FAKE_NOW_UNIX, { tmpRoot })).toThrow();
    expect(readdirSync(tmpRoot)).toEqual([]);
  });
});
