export interface MailMessage {
  from: { email: string; name: string };
  to: string;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
}

export interface AppEnv {
  DB: D1Database;
  EMAIL: { send(message: MailMessage): Promise<{ messageId: string }> };
  SUBSCRIBE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
  PUBLIC_ORIGIN: string;
  SITE_URL: string;
  FROM_ADDRESS: string;
  FROM_NAME: string;
  ADMIN_TOKEN: string;
}

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const hasControl = (value: string) => Array.from(value).some(char => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);

export const nowSeconds = () => Math.floor(Date.now() / 1000);

function base64url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function randomToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function digest(text: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export async function sha256(text: string) {
  return base64url(await digest(text));
}

export async function sameSecret(given: string, expected: string) {
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index]! ^ b[index]!;
  return difference === 0;
}

export function normalizeEmail(value: unknown) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || /\s/.test(email) || hasControl(email)) return null;
  const parts = email.split("@");
  if (parts.length !== 2) return null;
  const [local, domain] = parts as [string, string];
  if (!local || !domain.includes(".") || domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return null;
  return email;
}

export function cleanInstallId(value: unknown) {
  if (value === undefined) return { ok: true as const, value: null };
  if (typeof value !== "string" || value.length > 128 || hasControl(value)) return { ok: false as const };
  return { ok: true as const, value: value || null };
}

export const TEXT_VERSION = /^[0-9a-z][0-9a-z.-]{0,39}$/;

export function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readJson(request: Request, maxChars: number): Promise<unknown> {
  const text = await request.text();
  if (text.length > maxChars) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function errorCode(error: unknown) {
  const code = isRecord(error) ? error.code : undefined;
  return typeof code === "string" && code ? code.slice(0, 64) : "E_SEND_FAILED";
}
