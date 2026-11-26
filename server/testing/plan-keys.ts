import { generateKeyPairSync, sign } from "node:crypto";

export const DAY = 24 * 60 * 60_000;

/** A fresh Ed25519 pair; `publicKey` is the JWK `x` the server accepts as a trusted key. */
export function planKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  return {
    publicKey: String(jwk.x),
    mint(claims: { customer?: string; product?: string; issuedAt: number; expiresAt: number }): string {
      const payload = Buffer.from(JSON.stringify({
        v: 1, product: claims.product ?? "seira-team-premium", customer: claims.customer ?? "Test Customer",
        issuedAt: new Date(claims.issuedAt).toISOString(), expiresAt: new Date(claims.expiresAt).toISOString(),
      })).toString("base64url");
      return `seira-team.${payload}.${sign(null, Buffer.from(payload, "ascii"), privateKey).toString("base64url")}`;
    },
  };
}
