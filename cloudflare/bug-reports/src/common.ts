export const hasControl = (value: string) =>
  Array.from(value).some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);

export function base64url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function digest(text: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export async function sha256(text: string) {
  return base64url(await digest(text));
}

export async function sha256Hex(text: string) {
  return Array.from(await digest(text), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const IP_HASH_INFO = "seira-bug-reports/ip-hash/v1";
const ipHashKeys = new Map<string, Promise<CryptoKey>>();

/** HMAC key derived with HKDF-SHA256 from the secret, so the secret itself is never an HMAC key. Cached per isolate. */
function ipHashKey(secret: string) {
  let key = ipHashKeys.get(secret);
  if (!key) {
    key = crypto.subtle
      .importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"])
      .then((material) =>
        crypto.subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(IP_HASH_INFO) },
          material,
          { name: "HMAC", hash: "SHA-256", length: 256 },
          false,
          ["sign"],
        ),
      );
    ipHashKeys.clear();
    ipHashKeys.set(secret, key);
  }
  return key;
}

/** Hex HMAC-SHA256 of `ip:` + the IP address, keyed with a sub-key of `secret`. */
export async function ipHashOf(secret: string, ip: string) {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await ipHashKey(secret), new TextEncoder().encode(`ip:${ip}`)));
  return Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function tooMany(retryAfter: number, error = "Too many requests. Try again later.") {
  return json({ error, retryAfter }, 429, { "retry-after": String(retryAfter) });
}

/** The request text, or null when the body is larger than `cap` bytes. Stops reading at the cap. */
export async function readCapped(request: Request, cap: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
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
