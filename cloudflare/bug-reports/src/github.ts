import { base64url } from "./common";
import type { AppEnv, Deps } from "./env";
import { issueMarker } from "./issue-text";

const API = "https://api.github.com";
const TOKEN_REUSE_MARGIN_MS = 5 * 60 * 1000;

export class GitHubError extends Error {
  constructor(readonly status: number) {
    super(`github ${status}`);
  }
}

export interface GitHubIssue {
  number: number;
  state: string;
  state_reason?: string | null;
  body?: string | null;
  pull_request?: unknown;
  labels?: Array<string | { name?: string }>;
  milestone?: { title?: string } | null;
  user?: { type?: string; login?: string } | null;
  performed_via_github_app?: { id?: number } | null;
}

const text = new TextEncoder();

function lengthBytes(length: number) {
  if (length < 128) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return [0x80 | bytes.length, ...bytes];
}

function der(tag: number, ...parts: Array<ArrayLike<number>>) {
  const content = parts.flatMap((part) => Array.from(part));
  return [tag, ...lengthBytes(content.length), ...content];
}

function pkcs1ToPkcs8(pkcs1: Uint8Array) {
  const rsaAlgorithm = der(0x30, der(0x06, [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]), [0x05, 0x00]);
  return new Uint8Array(der(0x30, der(0x02, [0]), rsaAlgorithm, der(0x04, pkcs1)));
}

function privateKeyDer(pem: string) {
  const match = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(pem.replace(/\\n/g, "\n"));
  if (!match) throw new Error("private key is not PEM");
  const bytes = Uint8Array.from(atob((match[2] ?? "").replace(/\s+/g, "")), (char) => char.charCodeAt(0));
  return match[1] === "RSA PRIVATE KEY" ? pkcs1ToPkcs8(bytes) : bytes;
}

async function appJwt(env: AppEnv, nowSeconds: number) {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyDer(env.GITHUB_APP_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const part = (value: unknown) => base64url(text.encode(JSON.stringify(value)));
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({
    iat: nowSeconds - 60,
    exp: nowSeconds + 540,
    iss: env.GITHUB_APP_ID,
  })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, text.encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

function headers(token: string, extra: Record<string, string> = {}) {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "seira-bug-reports",
    authorization: `Bearer ${token}`,
    ...extra,
  };
}

function repository(env: AppEnv) {
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(env.GITHUB_REPOSITORY);
  if (!match) throw new Error("repository is not owner/name");
  return { owner: match[1]!, name: match[2]!, path: `/repos/${match[1]}/${match[2]}` };
}

export async function installationToken(env: AppEnv, deps: Deps) {
  const cacheKey = `${env.GITHUB_APP_ID}:${env.GITHUB_APP_INSTALLATION_ID}`;
  const cached = deps.tokens.get(cacheKey);
  if (cached && cached.expiresAt - TOKEN_REUSE_MARGIN_MS > deps.now()) return cached.token;

  const jwt = await appJwt(env, Math.floor(deps.now() / 1000));
  const response = await deps.fetch(
    `${API}/app/installations/${encodeURIComponent(env.GITHUB_APP_INSTALLATION_ID)}/access_tokens`,
    {
      method: "POST",
      headers: headers(jwt, { "content-type": "application/json" }),
      body: JSON.stringify({ repositories: [repository(env).name], permissions: { issues: "write" } }),
    },
  );
  if (!response.ok) throw new GitHubError(response.status);
  const answer = (await response.json()) as { token?: unknown; expires_at?: unknown };
  const expiresAt = typeof answer.expires_at === "string" ? Date.parse(answer.expires_at) : NaN;
  if (typeof answer.token !== "string" || !Number.isFinite(expiresAt)) throw new GitHubError(502);
  deps.tokens.set(cacheKey, { token: answer.token, expiresAt });
  return answer.token;
}

async function call(env: AppEnv, deps: Deps, method: string, path: string, body?: unknown, retried = false) {
  const token = await installationToken(env, deps);
  const response = await deps.fetch(`${API}${path}`, {
    method,
    headers: headers(token, body === undefined ? {} : { "content-type": "application/json" }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 401 && !retried) {
    deps.tokens.delete(`${env.GITHUB_APP_ID}:${env.GITHUB_APP_INSTALLATION_ID}`);
    await response.body?.cancel().catch(() => {});
    return call(env, deps, method, path, body, true);
  }
  return response;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function getIssue(env: AppEnv, deps: Deps, number: number): Promise<GitHubIssue | null> {
  const response = await call(env, deps, "GET", `${repository(env).path}/issues/${number}`);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  return (await readJson(response)) as GitHubIssue | null;
}

/** Anyone can open an issue with the marker, so only an issue that a bot of this App filed counts. */
function isFromThisApp(env: AppEnv, issue: GitHubIssue) {
  const app = issue.performed_via_github_app;
  return issue.user?.type === "Bot" && (app == null || app.id === Number(env.GITHUB_APP_ID));
}

export async function findOpenIssue(env: AppEnv, deps: Deps, hash: string): Promise<number | null> {
  const repo = repository(env);
  const query = `"seira-fp:${hash}" repo:${repo.owner}/${repo.name} is:issue is:open in:body`;
  const response = await call(env, deps, "GET", `/search/issues?q=${encodeURIComponent(query)}&per_page=10`);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const answer = (await readJson(response)) as { items?: GitHubIssue[] } | null;
  const marker = issueMarker(hash);
  const hit = answer?.items?.find(
    (item) =>
      item.state === "open" &&
      !("pull_request" in item) &&
      typeof item.body === "string" &&
      item.body.startsWith(marker) &&
      isFromThisApp(env, item),
  );
  return hit?.number ?? null;
}

export async function createIssue(env: AppEnv, deps: Deps, title: string, body: string): Promise<number> {
  const response = await call(env, deps, "POST", `${repository(env).path}/issues`, {
    title,
    body,
    labels: ["bug", "from-app"],
  });
  if (!response.ok) throw new GitHubError(response.status);
  const issue = (await readJson(response)) as { number?: unknown } | null;
  if (typeof issue?.number !== "number") throw new GitHubError(502);
  return issue.number;
}

export async function createComment(env: AppEnv, deps: Deps, number: number, body: string): Promise<number | null> {
  const response = await call(env, deps, "POST", `${repository(env).path}/issues/${number}/comments`, { body });
  if (!response.ok) throw new GitHubError(response.status);
  const comment = (await readJson(response)) as { id?: unknown } | null;
  return typeof comment?.id === "number" ? comment.id : null;
}
