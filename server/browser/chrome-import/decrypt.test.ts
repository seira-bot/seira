import { describe, expect, it } from "vitest";

import type { CookieRow } from "./cookie-db.ts";
import { decryptCookies } from "./decrypt.ts";
import { loadKeys } from "./keys.ts";
import { FAKE_NOW_UNIX, encryptFakeValue, type FakeCookie } from "./testing/fake-profile.ts";

const keysFor = (secrets: string[] = []) => loadKeys("chrome", {
  runCommand: async () => secrets.map((secret) => `secret = ${secret}`).join("\n"), env: {}, platform: "linux",
});

function row(cookie: FakeCookie, version: number, extra: Partial<CookieRow> = {}): CookieRow {
  const encrypted = encryptFakeValue(cookie, version);
  return {
    hostKey: cookie.hostKey, name: cookie.name, value: encrypted.length === 0 ? cookie.value : "", encryptedValue: encrypted, path: "/",
    expiresUnix: FAKE_NOW_UNIX + 86_400, secure: true, httpOnly: true, sameSite: 1, ...extra,
  };
}

describe("decrypting cookie rows", () => {
  it("opens v10, v11 and plain values", async () => {
    const keys = await keysFor(["ring-pass"]);
    const result = decryptCookies([
      row({ hostKey: ".a.test", name: "one", value: "alpha" }, 23),
      row({ hostKey: ".a.test", name: "two", value: "beta", scheme: "v11", password: "ring-pass" }, 23),
      row({ hostKey: ".a.test", name: "three", value: "gamma", scheme: "plain" }, 23),
      row({ hostKey: ".a.test", name: "four", value: "delta", scheme: "v11", password: "" }, 23),
    ], keys, 23, FAKE_NOW_UNIX);
    expect(result.cookies.map((cookie) => [cookie.name, cookie.value])).toEqual([["one", "alpha"], ["two", "beta"], ["three", "gamma"], ["four", "delta"]]);
    expect(result.failed).toBe(0);
  });

  it("fails a value under an unknown prefix, a wrong password, or broken padding", async () => {
    const keys = await keysFor();
    const broken = row({ hostKey: "a.test", name: "x", value: "v" }, 23);
    broken.encryptedValue = broken.encryptedValue.subarray(0, broken.encryptedValue.length - 5);
    const result = decryptCookies([
      row({ hostKey: "a.test", name: "u", value: "v", scheme: "unknown" }, 23),
      row({ hostKey: "a.test", name: "w", value: "v", scheme: "v11", password: "other" }, 23),
      broken,
    ], keys, 23, FAKE_NOW_UNIX);
    expect(result).toMatchObject({ cookies: [], failed: 3 });
  });

  it("from version 24 accepts a value only when its first 32 bytes hash the host key", async () => {
    const keys = await keysFor();
    const good = row({ hostKey: ".a.test", name: "good", value: "ok" }, 24);
    const bad = row({ hostKey: ".a.test", name: "bad", value: "no", hashHost: ".other.test" }, 24);
    const result = decryptCookies([good, bad], keys, 24, FAKE_NOW_UNIX);
    expect(result.cookies.map((cookie) => cookie.value)).toEqual(["ok"]);
    expect(result.failed).toBe(1);
    expect(decryptCookies([row({ hostKey: ".a.test", name: "old", value: "no-prefix" }, 23)], keys, 24, FAKE_NOW_UNIX).failed).toBe(1);
  });

  it("skips expired cookies without trying a key, caps expiry at 30 days, and keeps session cookies as -1", async () => {
    const keys = await keysFor();
    const result = decryptCookies([
      row({ hostKey: "a.test", name: "dead", value: "v" }, 23, { expiresUnix: FAKE_NOW_UNIX - 1 }),
      row({ hostKey: "a.test", name: "far", value: "v" }, 23, { expiresUnix: FAKE_NOW_UNIX + 400 * 86_400 }),
      row({ hostKey: "a.test", name: "near", value: "v" }, 23, { expiresUnix: FAKE_NOW_UNIX + 3_600 }),
      row({ hostKey: "a.test", name: "sess", value: "v" }, 23, { expiresUnix: null }),
    ], keys, 23, FAKE_NOW_UNIX);
    expect(result.expired).toBe(1);
    expect(result.cookies.map((cookie) => [cookie.name, cookie.expires])).toEqual([
      ["far", FAKE_NOW_UNIX + 30 * 86_400], ["near", FAKE_NOW_UNIX + 3_600], ["sess", -1],
    ]);
  });

  it("maps flags and sameSite, and omits sameSite when unspecified or None without Secure", async () => {
    const keys = await keysFor();
    const cookie = (name: string, sameSite: number, secure = true) => row({ hostKey: "a.test", name, value: "v" }, 23, { sameSite, secure, httpOnly: false });
    const result = decryptCookies([cookie("none", 0), cookie("lax", 1), cookie("strict", 2), cookie("unset", -1), cookie("insecure-none", 0, false)], keys, 23, FAKE_NOW_UNIX);
    expect(result.cookies.map((entry) => entry.sameSite)).toEqual(["None", "Lax", "Strict", undefined, undefined]);
    expect(result.cookies[0]).toMatchObject({ domain: "a.test", path: "/", httpOnly: false, secure: true });
    expect("sameSite" in result.cookies[3]!).toBe(false);
  });
});
