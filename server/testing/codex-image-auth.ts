// A synthetic Codex ChatGPT sign-in (<CODEX_HOME>/auth.json) for image tests. Nothing here is a real token: OpenAI
// checks the signature, and every test that uses it answers with a fake fetch.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** A JWT-shaped string with these claims; `signature` lets a test look for the token in what it must not reach. */
export function fakeJwt(claims: Record<string, unknown>, signature = "synthetic-signature"): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.${signature}`;
}

/** Writes Codex's sign-in file; `token` ends the access token, so a test can check that it never leaks. */
export function codexAuthFile(codexHome: string, sign: { token: string; accountId: string; plan?: string | null; expiresAt?: number }): string {
  const access = fakeJwt({
    ...(sign.expiresAt !== undefined && { exp: Math.floor(sign.expiresAt / 1000) }),
    "https://api.openai.com/auth": { chatgpt_account_id: sign.accountId, ...(sign.plan ? { chatgpt_plan_type: sign.plan } : {}) },
  }, sign.token);
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt", OPENAI_API_KEY: null,
    tokens: { access_token: access, refresh_token: "synthetic-refresh", id_token: fakeJwt({}), account_id: sign.accountId },
  }));
  return access;
}
