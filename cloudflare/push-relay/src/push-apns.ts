// APNs accepts a push for an App Store or TestFlight build only when the publishing team's key signs it.
import { base64url, sha256Hex } from "./common";
import type { AppEnv } from "./env";
import { PEM, pemBytes } from "./push-fcm";

export type ApnsEnvironment = "production" | "sandbox";

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  /** The .p8 key as PEM (PKCS #8). */
  privateKey: string;
  /** The app's bundle id: the APNs topic. */
  bundleId: string;
  environments: ReadonlySet<ApnsEnvironment>;
}

export const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};

/** APNs wants a provider token renewed no more than every 20 and at least every 60 minutes. */
export const APNS_TOKEN_WINDOW_MS = 50 * 60 * 1_000;

const KEY_OR_TEAM_ID = /^[A-Z0-9]{10}$/;
const BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

export function readApnsConfig(env: AppEnv): ApnsConfig | null {
  const { APNS_KEY_ID: keyId, APNS_TEAM_ID: teamId, APNS_BUNDLE_ID: bundleId, APNS_PRIVATE_KEY: rawKey } = env;
  if (typeof keyId !== "string" || !KEY_OR_TEAM_ID.test(keyId)) return null;
  if (typeof teamId !== "string" || !KEY_OR_TEAM_ID.test(teamId)) return null;
  if (typeof bundleId !== "string" || bundleId.length > 155 || !BUNDLE_ID.test(bundleId)) return null;
  if (typeof rawKey !== "string") return null;
  // `wrangler secret put` from a file keeps the newlines. A pasted value may carry them escaped.
  const privateKey = rawKey.replace(/\\n/g, "\n").trim();
  if (!PEM.test(privateKey)) return null;
  const listed = env.APNS_ENVIRONMENTS?.trim() ? env.APNS_ENVIRONMENTS.split(",").map((value) => value.trim()) : ["production"];
  if (!listed.every((value) => value === "production" || value === "sandbox")) return null;
  return { keyId, teamId, privateKey, bundleId, environments: new Set(listed as ApnsEnvironment[]) };
}

interface CachedToken {
  fingerprint: string;
  window: number;
  jwt: string;
}
let cachedToken: CachedToken | null = null;

export function forgetApnsToken(): void {
  cachedToken = null;
}

/** ES256 per RFC 7518 section 3.4: the raw r and s signature that WebCrypto returns. */
export async function apnsProviderToken(config: ApnsConfig, now: number): Promise<string> {
  const window = Math.floor(now / APNS_TOKEN_WINDOW_MS);
  const fingerprint = `${config.teamId}:${config.keyId}:${await sha256Hex(config.privateKey)}`;
  if (cachedToken && cachedToken.fingerprint === fingerprint && cachedToken.window === window) return cachedToken.jwt;
  const key = await crypto.subtle.importKey("pkcs8", pemBytes(config.privateKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const encoder = new TextEncoder();
  const header = base64url(encoder.encode(JSON.stringify({ alg: "ES256", kid: config.keyId })));
  const claims = base64url(encoder.encode(JSON.stringify({ iss: config.teamId, iat: Math.floor((window * APNS_TOKEN_WINDOW_MS) / 1_000) })));
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(`${header}.${claims}`));
  const jwt = `${header}.${claims}.${base64url(signature)}`;
  cachedToken = { fingerprint, window, jwt };
  return jwt;
}
