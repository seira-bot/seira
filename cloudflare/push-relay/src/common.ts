export class HTTPError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly retryAfter?: number,
  ) {
    super(code);
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function errorResponse(status: number, code: string, retryAfter?: number) {
  return json({ error: code }, status, retryAfter === undefined ? {} : { "retry-after": String(retryAfter) });
}

export const noContent = () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

export function base64url(bytes: ArrayBuffer | Uint8Array) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function randomBase64url(size: number) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(text: string) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** Hex HMAC-SHA-256 of `text`, keyed with `secret`. */
export async function hmacHex(secret: string, text: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}

/** Compares two hex digests without stopping at the first difference. */
export function timingSafeEqualHex(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

export const MAX_BODY_BYTES = 16 * 1024;

/** The body text, or null when it is larger than the cap. Stops reading at the cap. */
async function readCapped(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** The parsed JSON body, or an HTTPError 400 `invalid_request` for a large, empty, or bad body. */
export async function readJson(request: Request): Promise<unknown> {
  const text = await readCapped(request);
  if (text === null || text === "") throw new HTTPError(400, "invalid_request");
  try {
    return JSON.parse(text);
  } catch {
    throw new HTTPError(400, "invalid_request");
  }
}

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/** One JSON line for a failure. Only these four fields: never a credential, token, IP address, title, key, or body. */
export function logFailure(fields: { message: string; status?: number; platform?: string; reason?: string }) {
  console.error(JSON.stringify({ message: fields.message, status: fields.status, platform: fields.platform, reason: fields.reason }));
}
