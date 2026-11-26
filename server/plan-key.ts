// Security: a Premium key is checked here and only here, offline, against the public keys in shared/plan-keys.ts. The
// server never asks a Seira service about a key. A key that fails any check grants nothing.
import { createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { PLAN_PUBLIC_KEYS } from "../shared/plan-keys.ts";
import type { PremiumKeyStatus } from "../shared/people-plan.ts";
import { writeFileAtomic } from "./atomic.ts";
import { ensurePrivateDir } from "./data-dir.ts";
import { LICENSE_GRACE_DAYS, LICENSE_WARN_DAYS } from "./enterprise.ts";

export const TEAM_KEY_ENV = "SEIRA_TEAM_KEY";
export const TEAM_KEY_FILE = "team-key";

const KEY_PREFIX = "seira-team";
const KEY_PRODUCT = "seira-team-premium";
const DAY_MS = 24 * 60 * 60_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const payloadSchema = z.object({
  v: z.literal(1),
  product: z.string(),
  customer: z.string().trim().min(1).max(200),
  issuedAt: z.string(),
  expiresAt: z.string(),
});

export interface PlanKey {
  customer: string;
  issuedAt: number;
  expiresAt: number;
}

/** `ended`: genuine, but past its grace, so saving it would change nothing. */
export type PlanKeyRefusal = "format" | "signature" | "product" | "ended";

export type PlanKeyCheck = { ok: true; key: PlanKey; text: string } | { ok: false; reason: Exclude<PlanKeyRefusal, "ended"> };

function signedBy(publicKey: string, message: Buffer, signature: Buffer): boolean {
  try {
    return verify(null, message, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" }), signature);
  } catch {
    return false;
  }
}

/** Whitespace anywhere in the text is dropped first: a key pasted from an email often wraps. */
export function checkPlanKey(raw: string, publicKeys: readonly string[] = PLAN_PUBLIC_KEYS): PlanKeyCheck {
  const text = raw.replace(/\s+/g, "");
  const parts = text.split(".");
  const [prefix, encodedPayload, encodedSignature] = parts;
  if (parts.length !== 3 || prefix !== KEY_PREFIX || !BASE64URL.test(encodedPayload!) || !BASE64URL.test(encodedSignature!)) {
    return { ok: false, reason: "format" };
  }
  const signature = Buffer.from(encodedSignature!, "base64url");
  if (signature.length !== 64) return { ok: false, reason: "format" };
  let payload: z.infer<typeof payloadSchema>;
  try {
    payload = payloadSchema.parse(JSON.parse(Buffer.from(encodedPayload!, "base64url").toString("utf8")));
  } catch {
    return { ok: false, reason: "format" };
  }
  const issuedAt = Date.parse(payload.issuedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return { ok: false, reason: "format" };
  // The signer signs the encoded payload text alone; the product field keeps its other signatures apart.
  const message = Buffer.from(encodedPayload!, "ascii");
  if (!publicKeys.some((publicKey) => signedBy(publicKey, message, signature))) return { ok: false, reason: "signature" };
  if (payload.product !== KEY_PRODUCT) return { ok: false, reason: "product" };
  return { ok: true, key: { customer: payload.customer, issuedAt, expiresAt }, text };
}

const day = (at: number) => new Date(at).toISOString().slice(0, 10);

function keyStatus(key: PlanKey, source: PremiumKeyStatus["source"], now: number): PremiumKeyStatus {
  const graceEnd = key.expiresAt + LICENSE_GRACE_DAYS * DAY_MS;
  const daysLeft = Math.ceil((key.expiresAt - now) / DAY_MS);
  const state = now >= graceEnd ? "ended" : now >= key.expiresAt ? "grace" : daysLeft <= LICENSE_WARN_DAYS ? "endingSoon" : "active";
  return {
    state, source, customer: key.customer, endsOn: day(key.expiresAt), daysLeft,
    ...(state === "grace" || state === "ended" ? { graceEndsOn: day(graceEnd) } : {}),
  };
}

export interface PlanKeyOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  publicKeys?: readonly string[];
}

/** The key in force: SEIRA_TEAM_KEY when it names one, else the key saved from Settings. Null when there is none. */
export function premiumKeyStatus(options: PlanKeyOptions, now: number = Date.now()): PremiumKeyStatus | null {
  const fromEnv = (options.env ?? process.env)[TEAM_KEY_ENV]?.trim();
  if (fromEnv) {
    const checked = checkPlanKey(fromEnv, options.publicKeys);
    return checked.ok ? keyStatus(checked.key, "environment", now) : { state: "invalid", source: "environment" };
  }
  const file = join(options.dataDir, TEAM_KEY_FILE);
  if (!existsSync(file)) return null;
  let saved: string;
  try {
    saved = readFileSync(file, "utf8");
  } catch {
    return { state: "unreadable", source: "settings" };
  }
  const checked = checkPlanKey(saved, options.publicKeys);
  return checked.ok ? keyStatus(checked.key, "settings", now) : { state: "invalid", source: "settings" };
}

/** A key that still lifts the people limit: valid and not past its grace. */
export function premiumUnlimited(status: PremiumKeyStatus | null): boolean {
  return status?.state === "active" || status?.state === "endingSoon" || status?.state === "grace";
}

/** Saves a key from Settings (owner-only file). A refused key leaves the saved one as it was. */
export function savePlanKey(options: PlanKeyOptions, raw: string, now: number = Date.now()): { ok: true; status: PremiumKeyStatus } | { ok: false; reason: PlanKeyRefusal } {
  const checked = checkPlanKey(raw, options.publicKeys);
  if (!checked.ok) return checked;
  const status = keyStatus(checked.key, "settings", now);
  if (status.state === "ended") return { ok: false, reason: "ended" };
  ensurePrivateDir(options.dataDir);
  writeFileAtomic(join(options.dataDir, TEAM_KEY_FILE), `${checked.text}\n`, { mode: 0o600 });
  return { ok: true, status };
}
