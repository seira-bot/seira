import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";

import type { ImportCookie } from "../../browser-sites.ts";
import type { CookieRow } from "./cookie-db.ts";
import type { DerivedKeys } from "./keys.ts";

export interface DecryptResult {
  cookies: ImportCookie[];
  expired: number;
  failed: number;
}

const MAX_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const HASH_PREFIX_VERSION = 24;
const IV = Buffer.alloc(16, 0x20);
const SAME_SITE = ["None", "Lax", "Strict"] as const;

function openWith(key: Buffer, body: Buffer): Buffer | null {
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, IV);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch { return null; }
}

function decryptValue(row: CookieRow, keys: DerivedKeys, version: number): string | null {
  const data = row.encryptedValue;
  if (data.length === 0) return row.value;
  const prefix = data.subarray(0, 3).toString("latin1");
  const candidates = prefix === "v10" ? keys.v10 : prefix === "v11" ? keys.v11 : [];
  const body = data.subarray(3);
  if (body.length === 0 || body.length % 16 !== 0) return null;
  const expected = version >= HASH_PREFIX_VERSION ? createHash("sha256").update(row.hostKey).digest() : null;
  for (const key of candidates) {
    const plain = openWith(key, body);
    if (!plain) continue;
    if (!expected) return plain.toString("utf8");
    if (plain.length >= 32 && timingSafeEqual(plain.subarray(0, 32), expected)) return plain.subarray(32).toString("utf8");
  }
  return null;
}

/** Decrypts exactly the rows it is given. Expired cookies are skipped before any key is tried. */
export function decryptCookies(rows: readonly CookieRow[], keys: DerivedKeys, version: number, nowUnix: number): DecryptResult {
  const result: DecryptResult = { cookies: [], expired: 0, failed: 0 };
  for (const row of rows) {
    if (row.expiresUnix !== null && row.expiresUnix <= nowUnix) { result.expired += 1; continue; }
    const value = decryptValue(row, keys, version);
    if (value === null) { result.failed += 1; continue; }
    const sameSite = SAME_SITE[row.sameSite];
    const expires = row.expiresUnix === null ? -1 : Math.min(row.expiresUnix, nowUnix + MAX_LIFETIME_SECONDS);
    result.cookies.push({
      name: row.name,
      value,
      domain: row.hostKey,
      path: row.path,
      expires,
      httpOnly: row.httpOnly,
      secure: row.secure,
      ...(sameSite && (sameSite !== "None" || row.secure) ? { sameSite } : {}),
    });
  }
  return result;
}
