import { createPublicKey, generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

import type { AppEnv, Deps } from "./env";
import { handle } from "./index";

/** D1 over node:sqlite with the real migrations: the same SQLite engine, so constraints, RETURNING and partial
 *  indexes behave as they do in D1. `migrations` limits how many migration files run. */
export function fakeD1(migrations = Infinity) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort().slice(0, migrations)) {
    db.exec(readFileSync(new URL(file, dir), "utf8"));
  }
  const sqlLog: string[] = [];
  function params(values: unknown[]) {
    return values.map((value) => {
      if (value === undefined) throw new TypeError("D1_TYPE_ERROR: undefined cannot be bound");
      return (typeof value === "boolean" ? Number(value) : value) as SQLInputValue;
    });
  }
  const plain = (row: unknown) => (row ? { ...(row as object) } : null);
  function execute(statement: StatementSync, values: unknown[]) {
    if (statement.columns().length) {
      return { success: true, results: statement.all(...params(values)).map(plain), meta: { changes: 0 } };
    }
    const result = statement.run(...params(values));
    return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
  function prepared(sql: string, values: unknown[] = []) {
    const compile = () => {
      sqlLog.push(sql);
      return db.prepare(sql);
    };
    return {
      sql,
      values,
      bind: (...next: unknown[]) => prepared(sql, next),
      first: async <T>(column?: string) => {
        const row = plain(compile().get(...params(values))) as Record<string, unknown> | null;
        return (column ? row?.[column] ?? null : row) as T | null;
      },
      all: async () => execute(compile(), values),
      run: async () => execute(compile(), values),
      raw: async () => compile().all(...params(values)).map((row) => Object.values(row as object)),
    };
  }
  const D1 = {
    prepare: (sql: string) => prepared(sql),
    batch: async (statements: Array<ReturnType<typeof prepared>>) => {
      db.exec("BEGIN");
      try {
        const results = statements.map((statement) => {
          sqlLog.push(statement.sql);
          return execute(db.prepare(statement.sql), statement.values);
        });
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    exec: async (sql: string) => db.exec(sql),
  };
  const rows = <T = Record<string, unknown>>(sql: string, ...values: unknown[]) =>
    db.prepare(sql).all(...params(values)).map(plain) as T[];
  return { db, D1, rows, sqlLog };
}

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const publicKey: KeyObject = createPublicKey(keys.privateKey);
export const pkcs1Pem = keys.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
export const pkcs8Pem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

export const APP_ID = "424242";
export const INSTALLATION_ID = "777001";
export const REPO = "seira-bot/seira";

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  state_reason: string | null;
  labels: Array<{ name: string }>;
  milestone: { title: string } | null;
  pull_request?: unknown;
  user: { type: string; login: string } | null;
  performed_via_github_app: { id: number } | null;
}

type Failure = "throw" | number | undefined;

export interface Clock {
  ms: number;
  advance(seconds: number): void;
}

function decodePart(part: string) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

export function fakeGitHub(clock: Clock) {
  const requests: RecordedRequest[] = [];
  const issues = new Map<number, FakeIssue>();
  const comments: Array<{ issue: number; id: number; body: string }> = [];
  const jwts: Array<{ header: Record<string, unknown>; claims: Record<string, unknown> }> = [];
  const fail: { token: Failure; getIssue: Failure; search: Failure; create: Failure; comment: Failure } = {
    token: undefined,
    getIssue: undefined,
    search: undefined,
    create: undefined,
    comment: undefined,
  };
  const validTokens = new Map<string, number>();
  let tokenCount = 0;
  let nextIssue = 100;
  let nextComment = 9000;
  const tokenLifetimeMs = 60 * 60 * 1000;
  const repoPath = `/repos/${REPO}`;

  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  function failure(mode: Failure) {
    if (mode === "throw") throw new TypeError("network down");
    return typeof mode === "number" ? reply({ message: "failure" }, mode) : null;
  }

  function seed(partial: Partial<FakeIssue> = {}) {
    const number = nextIssue++;
    const issue: FakeIssue = {
      number,
      title: "seeded",
      body: "",
      state: "open",
      state_reason: null,
      labels: [],
      milestone: null,
      user: { type: "User", login: "someone" },
      performed_via_github_app: null,
      ...partial,
    };
    issues.set(number, issue);
    return issue;
  }

  async function fetchFake(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({ method, url: url.href, path: url.pathname, headers, body });
    const bearer = headers.authorization?.replace(/^Bearer /, "") ?? "";

    if (method === "POST" && url.pathname === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
      const refused = failure(fail.token);
      if (refused) return refused;
      const [header, claims, signature] = bearer.split(".");
      const signed = verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature ?? "", "base64url"));
      if (!signed) return reply({ message: "bad jwt" }, 401);
      jwts.push({ header: decodePart(header!), claims: decodePart(claims!) });
      tokenCount += 1;
      const token = `ghs_fake${tokenCount}`;
      const expiresAt = clock.ms + tokenLifetimeMs;
      validTokens.set(token, expiresAt);
      return reply({ token, expires_at: new Date(expiresAt).toISOString() }, 201);
    }

    const expiry = validTokens.get(bearer);
    if (expiry === undefined || expiry <= clock.ms) return reply({ message: "bad credentials" }, 401);

    const single = new RegExp(`^${repoPath}/issues/(\\d+)$`).exec(url.pathname);
    if (method === "GET" && single) {
      const refused = failure(fail.getIssue);
      if (refused) return refused;
      const issue = issues.get(Number(single[1]));
      return issue ? reply(issue) : reply({ message: "not found" }, 404);
    }
    if (method === "GET" && url.pathname === "/search/issues") {
      const refused = failure(fail.search);
      if (refused) return refused;
      const query = url.searchParams.get("q") ?? "";
      const hash = /"seira-fp:([0-9a-f]+)"/.exec(query)?.[1] ?? "";
      const items = [...issues.values()].filter((issue) => issue.state === "open" && issue.body.includes(`seira-fp:${hash}`));
      return reply({ total_count: items.length, items });
    }
    if (method === "POST" && url.pathname === `${repoPath}/issues`) {
      const refused = failure(fail.create);
      if (refused) return refused;
      const payload = body as { title: string; body: string; labels: string[] };
      const issue = seed({ title: payload.title, body: payload.body, labels: payload.labels.map((name) => ({ name })),
        user: { type: "Bot", login: "seira-bug-reports[bot]" },
        performed_via_github_app: { id: Number(APP_ID) },
      });
      return reply(issue, 201);
    }
    const comment = new RegExp(`^${repoPath}/issues/(\\d+)/comments$`).exec(url.pathname);
    if (method === "POST" && comment) {
      const refused = failure(fail.comment);
      if (refused) return refused;
      const id = nextComment++;
      comments.push({ issue: Number(comment[1]), id, body: (body as { body: string }).body });
      return reply({ id }, 201);
    }
    return reply({ message: "not found" }, 404);
  }

  return {
    fetch: fetchFake as unknown as typeof fetch,
    requests,
    issues,
    comments,
    jwts,
    fail,
    seed,
    /** Requests that are not token exchanges. */
    apiCalls: () => requests.filter((request) => !request.path.startsWith("/app/")),
    tokenRequests: () => requests.filter((request) => request.path.startsWith("/app/")),
    revokeTokens: () => validTokens.clear(),
    close(number: number, reason: string | null = "completed") {
      const issue = issues.get(number)!;
      issue.state = "closed";
      issue.state_reason = reason;
    },
  };
}

export const DIAGNOSTICS = [
  "## Recent problems in this conversation, newest last",
  "2026-11-19T10:00:00.000Z tool Bash failed: TypeError: x is undefined",
  "",
  "## Server warnings and errors, newest last",
  "2026-11-19T10:00:01.000Z error TypeError: x is undefined",
  "    at run (/srv/app/server/run-AbC123xy.js:12:5)",
].join("\n");

export function validReport(extra: Record<string, unknown> = {}) {
  return {
    installId: "install-id-for-tests-0001",
    source: "bot",
    description: "The Bash tool failed twice in a row.",
    appVersion: "0.1.172",
    platform: "linux",
    diagnostics: DIAGNOSTICS,
    ...extra,
  };
}

export function bugHarness(env: Partial<AppEnv> = {}) {
  const d1 = fakeD1();
  const clock: Clock = {
    ms: Date.UTC(2026, 10, 19, 10, 0, 0),
    advance(seconds) {
      clock.ms += seconds * 1000;
    },
  };
  const github = fakeGitHub(clock);
  const limits = { report: true, status: true, keys: [] as string[], statusKeys: [] as string[] };
  const fullEnv: AppEnv = {
    DB: d1.D1 as unknown as D1Database,
    REPORT_LIMITER: {
      limit: async ({ key }) => {
        limits.keys.push(key);
        return { success: limits.report };
      },
    },
    STATUS_LIMITER: {
      limit: async ({ key }) => {
        limits.statusKeys.push(key);
        return { success: limits.status };
      },
    },
    GITHUB_REPOSITORY: REPO,
    GLOBAL_HOURLY_LIMIT: "120",
    GITHUB_APP_ID: APP_ID,
    GITHUB_APP_INSTALLATION_ID: INSTALLATION_ID,
    GITHUB_APP_PRIVATE_KEY: pkcs8Pem,
    ...env,
  };
  const deps: Deps = { fetch: github.fetch, now: () => clock.ms, tokens: new Map() };

  const call = (path: string, init: RequestInit = {}) => handle(new Request(`https://bugs.test${path}`, init), fullEnv, deps);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    call(path, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  return {
    d1,
    clock,
    github,
    limits,
    env: fullEnv,
    deps,
    call,
    send: (body: unknown, headers?: Record<string, string>) => post("/api/bug-reports", body, headers),
    status: (body: unknown, headers?: Record<string, string>) => post("/api/bug-reports/status", body, headers),
    /** Sends a valid report; the description differs for each `n`, so no two are the same payload. */
    async sendNumbered(n: number, installId = "install-id-for-tests-0001", headers?: Record<string, string>) {
      const response = await post("/api/bug-reports", validReport({ installId, description: `The Bash tool failed, case ${n}.` }), headers);
      return { response, body: (await response.clone().json()) as { id?: string; issue?: number; joined?: boolean } };
    },
    reportRows: () => d1.rows<{ id: string; issue_number: number; comment_id: number | null; install_hash: string; fingerprint: string }>("SELECT * FROM reports ORDER BY rowid"),
    everyTable: () => JSON.stringify(["reports", "fingerprints", "issues"].map((table) => d1.rows(`SELECT * FROM ${table}`))),
  };
}

export const bodiesOf = (requests: RecordedRequest[]) => JSON.stringify(requests.map((request) => request.body ?? null));
