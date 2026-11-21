// Images use Codex's own ChatGPT sign-in: <CODEX_HOME>/auth.json in Codex's default "file" credential store.
// Security: the token and the account id stay in this module and in the request headers; only `signedIn` and the
// plan name may leave the server.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { InstanceConfigMap } from "./contracts.ts";
import { codexAccountRead, codexHome } from "./drivers/codex-identity.ts";
import { augmentedPath } from "./env-path.ts";

type Env = Record<string, string | undefined>;

export interface CodexImageSource {
  cli: string;
  env: Env;
}

export interface CodexImageLogin {
  token: string;
  accountId: string;
  /** OpenAI's `chatgpt_plan_type` claim, such as "plus" or "free"; null when the token does not say. */
  plan: string | null;
  expired: boolean;
}

const MAX_AUTH_FILE_BYTES = 512_000;
/** A token that ends this soon is renewed before the request, not after a refusal. */
const EXPIRY_MARGIN_MS = 60_000;
const RENEW_TIMEOUT_MS = 20_000;
const PLAN = /^[a-z][a-z0-9_-]{0,39}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown, max = 16_000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max && !/[\r\n]/.test(trimmed) ? trimmed : null;
}

/** The unverified payload of a JWT: only Codex's own file supplies it, and OpenAI checks the signature. */
function jwtClaims(token: string | null): Record<string, unknown> | null {
  const part = token?.split(".")[1];
  if (!part) return null;
  try {
    return record(JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

/** The Codex homes to look in: each plain Codex engine first, then Codex's default home. An engine that signs in
 * through this app, a direct API or a company endpoint has no ChatGPT sign-in of Codex's own. */
export function codexImageSources(instances: InstanceConfigMap | undefined, env: Env = process.env): CodexImageSource[] {
  const sources: CodexImageSource[] = [];
  for (const entry of Object.values(instances ?? {})) {
    if (entry.driver !== "codex" || entry.enabled === false) continue;
    const config = record(entry.config) ?? {};
    if (config.authMode !== undefined || config.endpoint !== undefined || config.managed !== undefined) continue;
    sources.push({ cli: text(config.cli, 4096) ?? "codex", env: { ...env, ...entry.environment } });
  }
  sources.push({ cli: "codex", env });
  return sources;
}

export function readCodexImageLogin(source: CodexImageSource, now = Date.now()): CodexImageLogin | null {
  const home = codexHome(source.env);
  if (!home) return null;
  const path = join(home, "auth.json");
  let root: Record<string, unknown> | null;
  try {
    if (statSync(path).size > MAX_AUTH_FILE_BYTES) return null;
    root = record(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
  if (!root || root.auth_mode === "apikey") return null;
  const tokens = record(root.tokens);
  const token = text(tokens?.access_token);
  if (!token) return null;
  const access = jwtClaims(token);
  const id = jwtClaims(text(tokens?.id_token));
  const auth = record(access?.["https://api.openai.com/auth"]) ?? record(id?.["https://api.openai.com/auth"]);
  const accountId = text(tokens?.account_id, 200) ?? text(auth?.chatgpt_account_id, 200);
  if (!accountId) return null;
  const plan = text(auth?.chatgpt_plan_type, 40)?.toLowerCase() ?? null;
  const exp = typeof access?.exp === "number" ? access.exp * 1000 : null;
  return { token, accountId, plan: plan && PLAN.test(plan) ? plan : null, expired: exp !== null && exp <= now + EXPIRY_MARGIN_MS };
}

/** The first Codex home with a ChatGPT sign-in, with the source that renews it. */
export function codexImageLogin(instances: InstanceConfigMap | undefined, env: Env = process.env, now = Date.now()):
  { login: CodexImageLogin; source: CodexImageSource } | null {
  for (const source of codexImageSources(instances, env)) {
    const login = readCodexImageLogin(source, now);
    if (login) return { login, source };
  }
  return null;
}

const renewing = new Map<string, Promise<boolean>>();

/** Asks Codex to renew its own sign-in; true when Codex answered with a ChatGPT account. One renewal at a time per
 * Codex home: two renewals at once could spend the same refresh token twice and sign Codex out. */
export function renewCodexImageLogin(source: CodexImageSource): Promise<boolean> {
  const home = codexHome(source.env);
  if (!home) return Promise.resolve(false);
  const running = renewing.get(home);
  if (running) return running;
  const env: Env = { ...source.env, PATH: augmentedPath() };
  // An API key in the environment makes Codex answer for that key instead of its ChatGPT sign-in.
  delete env.OPENAI_API_KEY;
  const renewal = codexAccountRead(source.cli, env, { refreshToken: true }, RENEW_TIMEOUT_MS)
    .then((account) => account?.type === "chatgpt", () => false)
    .finally(() => renewing.delete(home));
  renewing.set(home, renewal);
  return renewal;
}

/** OpenAI's ChatGPT plans that Codex makes no images for. */
export function codexPlanMakesImages(plan: string | null): boolean {
  return plan !== "free";
}
