import { z } from "zod";

import { githubLevelPermissions, type GithubPermissions, type GithubRepoLevel } from "../../shared/github-app.ts";
import { brokerAccess, type BrokerAccess } from "../composio-broker-access.ts";

export type GithubBrokerErrorKind = "reconnect" | "unreachable" | "bad_code" | "gone";

export const GITHUB_RECONNECT_MESSAGE = "GitHub needs to be connected again.";
export const GITHUB_UNREACHABLE_MESSAGE = "GitHub is not reachable right now.";
export const GITHUB_BAD_CODE_MESSAGE = "That code is not valid. Check it and try again.";

export class GithubBrokerError extends Error {
  readonly kind: GithubBrokerErrorKind;
  constructor(kind: GithubBrokerErrorKind) {
    super(kind === "reconnect" || kind === "gone" ? GITHUB_RECONNECT_MESSAGE : kind === "bad_code" ? GITHUB_BAD_CODE_MESSAGE : GITHUB_UNREACHABLE_MESSAGE);
    this.name = "GithubBrokerError";
    this.kind = kind;
  }
}

const accountSchema = z.object({ login: z.string(), type: z.enum(["User", "Organization"]) });
const connectSchema = z.object({ url: z.string().url(), expiresAt: z.number().optional() });
const completeSchema = z.object({ linked: z.array(z.object({ id: z.number().int(), account: accountSchema })) });
const installationsSchema = z.object({
  installations: z.array(z.object({
    id: z.number().int(),
    account: z.object({ login: z.string(), type: z.enum(["User", "Organization"]), avatarUrl: z.string().optional() }),
    repositorySelection: z.enum(["all", "selected"]),
    suspended: z.boolean(),
    repositories: z.array(z.object({
      id: z.number().int(), name: z.string(), fullName: z.string(), private: z.boolean(), defaultBranch: z.string(),
    })),
  })),
  pending: z.array(z.object({ account: z.string().nullable() })),
});
const tokenSchema = z.object({ token: z.string().min(1), expiresAt: z.number() });
const unlinkSchema = z.object({ manageUrl: z.string() });

export type GithubBrokerInstallations = z.infer<typeof installationsSchema>;

export interface GithubBrokerClientDeps {
  access?: () => BrokerAccess | null;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export interface GithubBrokerClient {
  connect(returnTo?: string): Promise<{ url: string; expiresAt?: number }>;
  complete(code: string): Promise<{ linked: { id: number; account: { login: string; type: "User" | "Organization" } }[] }>;
  installations(): Promise<GithubBrokerInstallations>;
  unlink(installationId: number): Promise<{ manageUrl: string }>;
  /** The token stays in memory only. Callers must not log it, store it or put it in a result. */
  mintToken(installationId: number, repositoryId: number, level: GithubRepoLevel): Promise<{ token: string; expiresAt: number }>;
}

const TOKEN_MARGIN_MS = 5 * 60_000;

function safeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  } catch {
    return false;
  }
}

export function createGithubBrokerClient(deps: GithubBrokerClientDeps = {}): GithubBrokerClient {
  const access = deps.access ?? brokerAccess;
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { token: string; expiresAt: number }>();

  async function call<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown, missing: GithubBrokerErrorKind = "reconnect"): Promise<T> {
    let broker: BrokerAccess | null;
    try {
      broker = access();
    } catch {
      throw new GithubBrokerError("unreachable");
    }
    if (!broker) throw new GithubBrokerError("unreachable");
    let res: Response;
    try {
      res = await doFetch(`${broker.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${broker.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
      });
    } catch {
      throw new GithubBrokerError("unreachable");
    }
    if (res.status === 404) throw new GithubBrokerError(missing);
    if (res.status >= 400 && res.status < 500) throw new GithubBrokerError("reconnect");
    if (!res.ok) throw new GithubBrokerError("unreachable");
    try {
      return schema.parse(await res.json());
    } catch {
      throw new GithubBrokerError("unreachable");
    }
  }

  return {
    async connect(returnTo) {
      const out = await call("POST", "/v1/github/connect", connectSchema, returnTo ? { returnTo } : {});
      if (!safeUrl(out.url)) throw new GithubBrokerError("unreachable");
      return out;
    },
    complete: (code) => call("POST", "/v1/github/complete", completeSchema, { code }, "bad_code"),
    installations: () => call("GET", "/v1/github/installations", installationsSchema),
    unlink: (installationId) => call("DELETE", `/v1/github/installations/${installationId}`, unlinkSchema, undefined, "gone"),
    async mintToken(installationId, repositoryId, level) {
      const key = `${installationId}:${repositoryId}:${level}`;
      const cached = cache.get(key);
      if (cached && cached.expiresAt - TOKEN_MARGIN_MS > now()) return cached;
      const permissions: GithubPermissions = githubLevelPermissions(level);
      try {
        const minted = await call("POST", "/v1/github/token", tokenSchema, { installationId, repositoryIds: [repositoryId], permissions });
        cache.set(key, minted);
        return minted;
      } catch (error) {
        cache.delete(key);
        throw error;
      }
    },
  };
}
