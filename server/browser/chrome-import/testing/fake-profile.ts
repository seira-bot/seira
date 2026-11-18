// Builds browser configuration folders with Chrome's cookie schema and Linux cookie encryption. No real profile is read.
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const CHROME_EPOCH_OFFSET = 11_644_473_600;
export const FAKE_NOW_UNIX = 1_800_000_000;
export const FAKE_NOW_MS = FAKE_NOW_UNIX * 1000;

export function chromeMicroseconds(unix: number): bigint {
  return BigInt(Math.floor(unix) + CHROME_EPOCH_OFFSET) * 1_000_000n;
}

export type FakeScheme = "v10" | "v11" | "plain" | "unknown";

export interface FakeCookie {
  hostKey: string;
  name: string;
  value: string;
  path?: string;
  /** Seconds since 1970; `null` is a session cookie. */
  expiresUnix?: number | null;
  secure?: boolean;
  httpOnly?: boolean;
  lastAccessUnix?: number;
  /** Chrome's own numbers: -1 unspecified, 0 none, 1 lax, 2 strict. */
  sameSite?: number;
  topFrameSiteKey?: string;
  scheme?: FakeScheme;
  /** The keyring password a `v11` value is encrypted under. */
  password?: string;
  /** The host the version 24 prefix hashes, when it must differ from the cookie's own. */
  hashHost?: string;
}

export interface FakeProfileSpec {
  dir?: string;
  name?: string;
  version?: 17 | 18 | 23 | 24;
  cookies: FakeCookie[];
  layout?: "network" | "legacy";
  withWal?: boolean;
}

export function makeFakeHome(): string {
  return mkdtempSync(join(tmpdir(), "seira-fake-home-"));
}

function cipherKey(password: string): Buffer {
  return pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
}

export function encryptFakeValue(cookie: FakeCookie, version: number): Buffer {
  const scheme = cookie.scheme ?? "v10";
  if (scheme === "plain") return Buffer.alloc(0);
  const plain = Buffer.concat([
    version >= 24 ? createHash("sha256").update(cookie.hashHost ?? cookie.hostKey).digest() : Buffer.alloc(0),
    Buffer.from(cookie.value, "utf8"),
  ]);
  const password = scheme === "v11" ? cookie.password ?? "" : "peanuts";
  const cipher = createCipheriv("aes-128-cbc", cipherKey(password), Buffer.alloc(16, 0x20));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from(scheme === "unknown" ? "v99" : scheme), body]);
}

function writeCookieDatabase(path: string, spec: FakeProfileSpec): void {
  const version = spec.version ?? 24;
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR)");
    db.prepare("INSERT INTO meta(key, value) VALUES ('version', ?)").run(String(version));
    db.exec(`CREATE TABLE cookies(
      creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL,${version >= 18 ? " top_frame_site_key TEXT NOT NULL," : ""}
      name TEXT NOT NULL, value TEXT NOT NULL, encrypted_value BLOB NOT NULL, path TEXT NOT NULL,
      expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL, last_access_utc INTEGER NOT NULL,
      has_expires INTEGER NOT NULL, is_persistent INTEGER NOT NULL, priority INTEGER NOT NULL, samesite INTEGER NOT NULL,
      source_scheme INTEGER NOT NULL, source_port INTEGER NOT NULL, last_update_utc INTEGER NOT NULL)`);
    const insert = db.prepare(`INSERT INTO cookies(creation_utc, host_key,${version >= 18 ? " top_frame_site_key," : ""} name, value, encrypted_value, path,
      expires_utc, is_secure, is_httponly, last_access_utc, has_expires, is_persistent, priority, samesite, source_scheme, source_port, last_update_utc)
      VALUES (${Array.from({ length: version >= 18 ? 18 : 17 }, () => "?").join(", ")})`);
    spec.cookies.forEach((cookie, index) => {
      const encrypted = encryptFakeValue(cookie, version);
      const expires = cookie.expiresUnix === undefined ? FAKE_NOW_UNIX + 90 * 86_400 : cookie.expiresUnix;
      const access = chromeMicroseconds(cookie.lastAccessUnix ?? FAKE_NOW_UNIX - 3_600);
      const values: Array<string | number | bigint | Uint8Array> = [
        chromeMicroseconds(FAKE_NOW_UNIX - 86_400 + index), cookie.hostKey,
        ...(version >= 18 ? [cookie.topFrameSiteKey ?? ""] : []),
        cookie.name, encrypted.length === 0 ? cookie.value : "", encrypted, cookie.path ?? "/",
        expires === null ? 0n : chromeMicroseconds(expires),
        cookie.secure === false ? 0 : 1, cookie.httpOnly === false ? 0 : 1, access,
        expires === null ? 0 : 1, expires === null ? 0 : 1, 1, cookie.sameSite ?? -1, 2, 443, access,
      ];
      insert.run(...values);
    });
  } finally { db.close(); }
  if (spec.withWal) writeFileSync(`${path}-wal`, Buffer.alloc(0));
}

/** Writes `Local State` and one cookie database per profile into `configDir`. */
export function writeFakeBrowser(configDir: string, profiles: FakeProfileSpec[], lastUsed?: string): void {
  mkdirSync(configDir, { recursive: true });
  const infoCache: Record<string, { name: string }> = {};
  for (const spec of profiles) {
    const dir = spec.dir ?? "Default";
    infoCache[dir] = { name: spec.name ?? dir };
    writeCookieDatabase(join(configDir, dir, spec.layout === "legacy" ? "Cookies" : join("Network", "Cookies")), spec);
  }
  writeFileSync(join(configDir, "Local State"), JSON.stringify({ profile: { ...(lastUsed ? { last_used: lastUsed } : {}), info_cache: infoCache } }));
}
