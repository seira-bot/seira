import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface CookieDbOptions {
  /** Where the private copy lives; defaults to the system temporary folder. */
  tmpRoot?: string;
  /** Called with the private folder while the copy exists; lets a test check its permissions. */
  onCopy?: (directory: string) => void;
}

export interface HostSummary {
  hostKey: string;
  cookieCount: number;
  /** Some cookie of the host is secure, HTTP-only and persistent. */
  hasAuthShaped: boolean;
  /** Seconds since 1970. */
  lastAccess: number;
}

export interface CookieRow {
  hostKey: string;
  name: string;
  value: string;
  encryptedValue: Buffer;
  path: string;
  /** Seconds since 1970; `null` for a session cookie. */
  expiresUnix: number | null;
  secure: boolean;
  httpOnly: boolean;
  /** Chrome's own numbers: -1 unspecified, 0 none, 1 lax, 2 strict. */
  sameSite: number;
}

const CHROME_TO_UNIX = "11644473600";
const PARTITION_SCHEMA_VERSION = 18;
const HOST_CHUNK = 400;

function withPrivateCopy<T>(cookiesPath: string, options: CookieDbOptions, use: (db: DatabaseSync) => T): T {
  const directory = mkdtempSync(join(options.tmpRoot ?? tmpdir(), "seira-chrome-import-"));
  try {
    chmodSync(directory, 0o700);
    const copy = join(directory, "Cookies");
    writeFileSync(copy, readFileSync(cookiesPath), { mode: 0o600 });
    if (existsSync(`${cookiesPath}-wal`)) writeFileSync(`${copy}-wal`, readFileSync(`${cookiesPath}-wal`), { mode: 0o600 });
    options.onCopy?.(directory);
    const db = new DatabaseSync(copy, { readOnly: true });
    try { return use(db); }
    finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: unknown } | undefined;
  const version = Number.parseInt(String(row?.value ?? ""), 10);
  if (!Number.isInteger(version) || version < 1) throw new Error("Unsupported cookie database.");
  return version;
}

function visibleFilter(version: number): string {
  const partition = version >= PARTITION_SCHEMA_VERSION ? "top_frame_site_key = '' AND " : "";
  return `${partition}(has_expires = 0 OR (expires_utc / 1000000 - ${CHROME_TO_UNIX}) > ?)`;
}

/** Never selects a cookie's name, value or encrypted value. */
export function readHostSummaries(cookiesPath: string, nowUnix: number, options: CookieDbOptions = {}): HostSummary[] {
  return withPrivateCopy(cookiesPath, options, (db) => {
    const version = schemaVersion(db);
    const rows = db.prepare(`SELECT host_key AS hostKey, COUNT(*) AS cookieCount,
        MAX(is_httponly = 1 AND is_secure = 1 AND is_persistent = 1) AS hasAuthShaped,
        MAX(last_access_utc / 1000000 - ${CHROME_TO_UNIX}) AS lastAccess
      FROM cookies WHERE ${visibleFilter(version)} GROUP BY host_key`).all(Math.floor(nowUnix)) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      hostKey: String(row.hostKey),
      cookieCount: Number(row.cookieCount),
      hasAuthShaped: Number(row.hasAuthShaped) === 1,
      lastAccess: Number(row.lastAccess),
    }));
  });
}

export function readCookieRows(cookiesPath: string, hostKeys: readonly string[], nowUnix: number, options: CookieDbOptions = {}): { version: number; rows: CookieRow[] } {
  return withPrivateCopy(cookiesPath, options, (db) => {
    const version = schemaVersion(db);
    const rows: CookieRow[] = [];
    for (let start = 0; start < hostKeys.length; start += HOST_CHUNK) {
      const chunk = hostKeys.slice(start, start + HOST_CHUNK);
      const found = db.prepare(`SELECT host_key AS hostKey, name, value, encrypted_value AS encryptedValue, path,
          CASE WHEN has_expires = 0 THEN NULL ELSE expires_utc / 1000000 - ${CHROME_TO_UNIX} END AS expiresUnix,
          is_secure AS secure, is_httponly AS httpOnly, samesite AS sameSite
        FROM cookies WHERE host_key IN (${chunk.map(() => "?").join(", ")}) AND ${visibleFilter(version)}`)
        .all(...chunk, Math.floor(nowUnix)) as Array<Record<string, unknown>>;
      for (const row of found) {
        rows.push({
          hostKey: String(row.hostKey),
          name: String(row.name),
          value: typeof row.value === "string" ? row.value : "",
          encryptedValue: row.encryptedValue instanceof Uint8Array ? Buffer.from(row.encryptedValue) : Buffer.alloc(0),
          path: String(row.path),
          expiresUnix: row.expiresUnix === null ? null : Number(row.expiresUnix),
          secure: Number(row.secure) === 1,
          httpOnly: Number(row.httpOnly) === 1,
          sameSite: Number(row.sameSite),
        });
      }
    }
    return { version, rows };
  });
}
