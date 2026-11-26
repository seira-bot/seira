/**
 * The Ed25519 public keys that sign Premium keys, each the base64url of the raw 32-byte key (a JWK `x`). A list, so a new
 * signing key ships before the old one stops: a Premium key is valid when any key here verifies it. The private keys
 * never enter this repository.
 */
export const PLAN_PUBLIC_KEYS: readonly string[] = ["dxVTFtYD2K2M3Rqh8I1ziORXD1DWCn7h2kSaE7F0K7Q"];

/** Where an admin buys or renews Premium. */
export const PREMIUM_UPGRADE_URL = "https://cloud.seira.bot/premium";
