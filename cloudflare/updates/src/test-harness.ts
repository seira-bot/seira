import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

import worker from "./index";
import type { MailMessage } from "./common";

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

export const ADMIN_BEARER = "admin-token-for-tests";

export function updatesHarness() {
  const d1 = fakeD1();
  const emails: MailMessage[] = [];
  const mail = {
    /** Returns an error code to make a send throw, or undefined to let it through. */
    failWhen: (_message: MailMessage): string | undefined => undefined,
  };
  const limits = { allowed: true, keys: [] as string[] };
  const env = {
    DB: d1.D1,
    PUBLIC_ORIGIN: "https://updates.test",
    SITE_URL: "https://site.test",
    FROM_ADDRESS: "updates@site.test",
    FROM_NAME: "Seira",
    ADMIN_TOKEN: ADMIN_BEARER as string,
    EMAIL: {
      send: async (message: MailMessage) => {
        const code = mail.failWhen(message);
        if (code) throw Object.assign(new Error("send failed"), { code });
        emails.push(message);
        return { messageId: `msg_${emails.length}` };
      },
    },
    SUBSCRIBE_LIMITER: {
      limit: async ({ key }: { key: string }) => {
        limits.keys.push(key);
        return { success: limits.allowed };
      },
    },
  };
  const fetchWorker = (path: string, init: RequestInit = {}) =>
    worker.fetch(new Request(`https://updates.test${path}`, init), env as never);

  const harness = {
    d1,
    env,
    emails,
    mail,
    limits,
    fetch: fetchWorker,
    consent(body: unknown, headers: Record<string, string> = {}) {
      return fetchWorker("/api/updates-consent", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    },
    async optIn(email: string, extra: Record<string, unknown> = {}) {
      const response = await harness.consent({ status: "opted_in", email, installId: "install-1", textVersion: "v1", ...extra });
      return { response, body: await response.json() as { receipt?: string; error?: string } };
    },
    /** The token inside the link of the last confirmation email. */
    confirmToken() {
      const last = emails[emails.length - 1];
      return last?.text.match(/confirm\?t=([A-Za-z0-9_-]{43})/)?.[1] ?? "";
    },
    async confirmed(email: string) {
      await harness.optIn(email);
      const response = await harness.postForm("/confirm", { t: harness.confirmToken() });
      if (response.status !== 200) throw new Error(`confirm failed for ${email}`);
    },
    postForm(path: string, fields: Record<string, string>) {
      return fetchWorker(path, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
      });
    },
    admin(path: string, init: RequestInit = {}, token: string | null = ADMIN_BEARER) {
      const headers = new Headers(init.headers);
      if (token !== null) headers.set("authorization", `Bearer ${token}`);
      if (init.body) headers.set("content-type", "application/json");
      return fetchWorker(path, { ...init, headers });
    },
    send(body: Record<string, unknown>, token: string | null = ADMIN_BEARER) {
      return harness.admin("/admin/send", { method: "POST", body: JSON.stringify(body) }, token);
    },
    subscriber(email: string) {
      return d1.rows<{
        email: string; status: string; confirm_hash: string | null; confirm_sent_at: number | null;
        unsubscribe_token: string; confirmed_hash: string | null; confirmed_at: number | null; unsubscribed_at: number | null;
      }>("SELECT * FROM subscribers WHERE email = ?", email)[0];
    },
    receipts(email: string) {
      return d1.rows<{ receipt_hash: string; install_id: string | null; withdrawn_at: number | null }>(
        "SELECT * FROM receipts WHERE email = ?", email,
      );
    },
  };
  return harness;
}
