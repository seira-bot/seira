import { generateKeyPairSync } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

import type { AppEnv, Deps } from "./env";
import { handle } from "./index";
import { forgetApnsToken } from "./push-apns";
import { forgetFcmAccessToken } from "./push-fcm";

/** D1 over node:sqlite with the real migrations: the same SQLite engine, so constraints and upserts behave as they do in D1.
 *  `migrations` limits how many migration files run. */
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

const apnsKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const rsaKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const apnsPem = apnsKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const fcmPem = rsaKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

export const FCM_PROJECT = "seira-test-1";
export const fcmServiceAccount = JSON.stringify({
  type: "service_account",
  project_id: FCM_PROJECT,
  private_key_id: "0123456789abcdef",
  private_key: fcmPem,
  client_email: `firebase-adminsdk-test@${FCM_PROJECT}.iam.gserviceaccount.com`,
  token_uri: "https://attacker.example/token",
});

export const APNS_TOKEN = "a1".repeat(32);
export const OTHER_APNS_TOKEN = "b2".repeat(32);
export const FCM_DEVICE = `cXyZ_1234567890-abc:APA91b${"F".repeat(140)}`;
export const OTHER_FCM_DEVICE = `dQwE_0987654321-xyz:APA91b${"G".repeat(140)}`;
export const TEST_IP = "192.0.2.1";

export const NOTIFICATION = {
  kind: "approval",
  title: "Scout needs approval",
  botId: "bot_1",
  botName: "Hidden Bot Name",
  threadId: "th_1",
  roomId: "grp_1",
  roomName: "Launch plans",
  requestId: "req_1",
};

export interface ProviderCall {
  host: string;
  url: string;
  headers: Record<string, string>;
  text: string;
  body: Record<string, unknown> | null;
}

export interface Answer {
  status: number;
  body?: unknown;
}

/** One fake for APNs, Google's token endpoint, and FCM. Each has its own queue of answers. It answers 200 when the queue is empty. */
export function fakeProviders() {
  const calls: ProviderCall[] = [];
  const queues = { apns: [] as Answer[], oauth: [] as Answer[], fcm: [] as Answer[] };
  let count = 0;
  const providerFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const text = typeof init.body === "string" ? init.body : "";
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = null;
    }
    calls.push({ host: url.host, url: url.href, headers, text, body });
    count += 1;
    const kind = url.host === "oauth2.googleapis.com" ? "oauth" : url.host === "fcm.googleapis.com" ? "fcm" : "apns";
    const fallback: Answer =
      kind === "oauth" ? { status: 200, body: { access_token: `ya29.test-${count}`, expires_in: 3599 } }
      : kind === "fcm" ? { status: 200, body: { name: `projects/${FCM_PROJECT}/messages/1` } }
      : { status: 200 };
    const answer = queues[kind].shift() ?? fallback;
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  const of = (...hosts: string[]) => calls.filter((call) => hosts.includes(call.host));
  return {
    fetch: providerFetch,
    calls,
    queues,
    apns: () => of("api.push.apple.com", "api.sandbox.push.apple.com"),
    oauth: () => of("oauth2.googleapis.com"),
    fcm: () => of("fcm.googleapis.com"),
  };
}

export interface Clock {
  ms: number;
  advance(seconds: number): void;
}

interface Options {
  apns?: boolean;
  fcm?: boolean;
  env?: Partial<AppEnv>;
}

export function harness(options: Options = {}) {
  forgetApnsToken();
  forgetFcmAccessToken();
  const d1 = fakeD1();
  const clock: Clock = {
    ms: Date.UTC(2026, 10, 20, 10, 0, 0),
    advance(seconds) {
      clock.ms += seconds * 1000;
    },
  };
  const providers = fakeProviders();
  const limits = { enroll: true, request: true, enrollKeys: [] as string[], requestKeys: [] as string[] };
  const env: AppEnv = {
    DB: d1.D1 as unknown as D1Database,
    ENROLL_LIMITER: { limit: async ({ key }) => (limits.enrollKeys.push(key), { success: limits.enroll }) },
    REQUEST_LIMITER: { limit: async ({ key }) => (limits.requestKeys.push(key), { success: limits.request }) },
    PUSH_PAUSED: "false",
    ENROLL_PAUSED: "false",
    APNS_ENVIRONMENTS: "production,sandbox",
    ENROLL_PER_IP_DAILY: "5",
    ENROLL_GLOBAL_DAILY: "2000",
    SEND_GLOBAL_HOURLY: "20000",
    TOKEN_DAILY: "300",
    IP_HASH_KEY: "test-ip-hash-key",
    ...(options.apns === false ? {} : { APNS_KEY_ID: "KEY1234567", APNS_TEAM_ID: "TEAM123456", APNS_BUNDLE_ID: "bot.seira.test", APNS_PRIVATE_KEY: apnsPem }),
    ...(options.fcm === false ? {} : { FCM_SERVICE_ACCOUNT: fcmServiceAccount }),
    ...options.env,
  };
  const deps: Deps = { fetch: providers.fetch, now: () => clock.ms };

  interface CallOptions {
    body?: unknown;
    credential?: string;
    ip?: string | null;
    headers?: Record<string, string>;
  }
  const call = (method: string, path: string, { body, credential, ip = TEST_IP, headers = {} }: CallOptions = {}) =>
    handle(
      new Request(`https://push.test${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
          ...(ip ? { "cf-connecting-ip": ip } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      }),
      env,
      deps,
    );

  let installs = 0;
  /** Enrolls from a new IP address each time, so the per-IP daily limit never gets in the way. */
  async function install(ip = `198.51.100.${(installs += 1)}`) {
    const response = await call("POST", "/v1/push/enroll", { body: { v: 1 }, ip });
    const answer = (await response.clone().json()) as { installationId: string; credential: string; expiresAt: number };
    return { response, ...answer };
  }

  const tables = ["installations", "installation_credentials", "push_devices", "action_limits"];
  return {
    d1,
    clock,
    providers,
    limits,
    env,
    deps,
    call,
    install,
    register: (credential: string, body: unknown) => call("POST", "/v1/installations/self/push/register", { credential, body }),
    unregister: (credential: string, body: unknown) => call("POST", "/v1/installations/self/push/unregister", { credential, body }),
    send: (credential: string, token: string, notification: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
      call("POST", "/v1/installations/self/push/send", { credential, body: { v: 1, token, notification: { ...NOTIFICATION, ...notification }, ...extra } }),
    registerApns: (credential: string, token = APNS_TOKEN, environment = "production") => call("POST", "/v1/installations/self/push/register", { credential, body: { v: 1, token, environment } }),
    registerFcm: (credential: string, token = FCM_DEVICE) => call("POST", "/v1/installations/self/push/register", { credential, body: { v: 1, platform: "fcm", token } }),
    /** The text of every table. */
    everyTable: () => JSON.stringify(tables.map((table) => d1.rows(`SELECT * FROM ${table}`))),
    devices: () => d1.rows<{ installation_id: string; token_hash: string; platform: string; token: string }>("SELECT * FROM push_devices ORDER BY rowid"),
  };
}
