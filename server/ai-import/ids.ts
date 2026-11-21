import { createHash } from "node:crypto";

export function sha256(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

export function hashOf(value: unknown): string {
  return sha256(JSON.stringify(value));
}

/** A UUID-shaped id that is the same for the same parts, so a batch that runs again writes the same rows. */
export function stableId(...parts: string[]): string {
  const h = sha256(parts.join("\u0000"));
  const variant = ((Number.parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
