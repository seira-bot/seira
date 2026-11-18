import {
  TEXT_VERSION,
  TOKEN_PATTERN,
  cleanInstallId,
  errorCode,
  isRecord,
  json,
  normalizeEmail,
  nowSeconds,
  randomToken,
  readJson,
  sameSecret,
  sha256,
  type AppEnv,
} from "./common";
import { confirmationMessage, updateMessage } from "./mail";
import { page } from "./pages";

const RESEND_AFTER = 10 * 60;
const CONFIRM_VALID_FOR = 7 * 24 * 60 * 60;
const DEFAULT_BATCH = 25;
const MAX_BATCH = 40;

const methodNotAllowed = () => new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
const invalidRequest = () => json({ error: "invalid_request" }, 400);

interface SubscriberRow {
  status: "pending" | "confirmed" | "unsubscribed";
  confirm_hash: string | null;
  confirm_sent_at: number | null;
}

async function optIn(body: Record<string, unknown>, env: AppEnv) {
  const email = normalizeEmail(body.email);
  const installId = cleanInstallId(body.installId);
  const textVersion = body.textVersion;
  if (!email || !installId.ok || typeof textVersion !== "string" || !TEXT_VERSION.test(textVersion)) return invalidRequest();

  const now = nowSeconds();
  const existing = await env.DB.prepare("SELECT status, confirm_hash, confirm_sent_at FROM subscribers WHERE email = ?").bind(email).first<SubscriberRow>();
  const resendDue = !existing || existing.confirm_hash === null || existing.confirm_sent_at === null || existing.confirm_sent_at < now - RESEND_AFTER;
  const sendConfirmation = existing?.status === "confirmed" ? false : resendDue;

  let token: string | undefined;
  if (sendConfirmation) {
    token = randomToken();
    try {
      await env.EMAIL.send(confirmationMessage(env, email, token));
    } catch (error) {
      console.error("confirmation send failed", errorCode(error));
      return json({ error: "send_failed" }, 502);
    }
  }
  const confirmHash = token ? await sha256(token) : null;

  const statements: D1PreparedStatement[] = [];
  if (!existing) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO subscribers (email, status, text_version, confirm_hash, confirm_sent_at, unsubscribe_token, created_at, updated_at) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?) ON CONFLICT (email) DO NOTHING",
      ).bind(email, textVersion, confirmHash, now, randomToken(), now, now),
    );
  } else if (existing.status === "unsubscribed") {
    statements.push(
      env.DB.prepare(
        "UPDATE subscribers SET status = 'pending', text_version = ?, unsubscribed_at = NULL, confirmed_hash = NULL, confirm_hash = COALESCE(?, confirm_hash), confirm_sent_at = COALESCE(?, confirm_sent_at), updated_at = ? WHERE email = ?",
      ).bind(textVersion, confirmHash, token ? now : null, now, email),
    );
  } else if (existing.status === "pending" && token) {
    statements.push(
      env.DB.prepare("UPDATE subscribers SET text_version = ?, confirm_hash = ?, confirm_sent_at = ?, updated_at = ? WHERE email = ?").bind(
        textVersion,
        confirmHash,
        now,
        now,
        email,
      ),
    );
  }

  const receipt = randomToken();
  statements.push(
    env.DB.prepare(
      "INSERT INTO receipts (receipt_hash, email, install_id, text_version, created_at, confirm_hash) SELECT ?, email, ?, ?, ?, CASE WHEN status = 'confirmed' THEN NULL ELSE confirm_hash END FROM subscribers WHERE email = ?",
    ).bind(await sha256(receipt), installId.value, textVersion, now, email),
  );
  await env.DB.batch(statements);
  return json({ receipt });
}

async function withdraw(body: Record<string, unknown>, env: AppEnv) {
  const receipt = body.receipt;
  if (typeof receipt !== "string" || !TOKEN_PATTERN.test(receipt)) return invalidRequest();
  const hash = await sha256(receipt);
  const row = await env.DB.prepare("SELECT email, confirm_hash FROM receipts WHERE receipt_hash = ?").bind(hash).first<{ email: string; confirm_hash: string | null }>();
  if (!row) return json({ error: "unknown_receipt" }, 404);
  const now = nowSeconds();
  await env.DB.batch([
    env.DB.prepare("UPDATE receipts SET withdrawn_at = COALESCE(withdrawn_at, ?) WHERE receipt_hash = ?").bind(now, hash),
    env.DB.prepare(
      "UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = ?, updated_at = ? WHERE email = ? AND ? IS NOT NULL AND ((status = 'pending' AND confirm_hash = ?) OR (status = 'confirmed' AND confirmed_hash = ?))",
    ).bind(now, now, row.email, row.confirm_hash, row.confirm_hash, row.confirm_hash),
  ]);
  return json({ ok: true });
}

function unsubscribeStatement(env: AppEnv, column: "email" | "unsubscribe_token", value: string, now: number) {
  return env.DB.prepare(
    `UPDATE subscribers SET unsubscribed_at = CASE WHEN status = 'unsubscribed' THEN unsubscribed_at ELSE ? END, status = 'unsubscribed', updated_at = ? WHERE ${column} = ?`,
  ).bind(now, now, value);
}

async function updatesConsent(request: Request, env: AppEnv) {
  if (request.method !== "POST") return methodNotAllowed();
  const { success } = await env.SUBSCRIBE_LIMITER.limit({ key: request.headers.get("CF-Connecting-IP") ?? "unknown" });
  if (!success) return json({ error: "rate_limited" }, 429);
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
    return json({ error: "unsupported_media_type" }, 415);
  }
  const body = await readJson(request, 8192);
  if (!isRecord(body)) return invalidRequest();
  if (body.status === "opted_in") return optIn(body, env);
  if (body.status === "withdrawn" || body.status === "declined") return withdraw(body, env);
  return invalidRequest();
}

async function formValue(request: Request, name: string) {
  try {
    const value = (await request.formData()).get(name);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

const expiredPage = () => page("Link expired", "This link has expired. Turn on updates again in Seira.", undefined, 410);

async function confirm(request: Request, env: AppEnv, url: URL) {
  if (request.method === "GET") {
    const token = url.searchParams.get("t") ?? "";
    if (!TOKEN_PATTERN.test(token)) return expiredPage();
    return page("Confirm your subscription", "Press the button to get Seira updates by email.", {
      action: "/confirm",
      field: { name: "t", value: token },
      button: "Confirm subscription",
    });
  }
  if (request.method !== "POST") return methodNotAllowed();
  const token = (await formValue(request, "t")) ?? url.searchParams.get("t") ?? "";
  if (!TOKEN_PATTERN.test(token)) return expiredPage();
  const now = nowSeconds();
  const result = await env.DB.prepare(
    "UPDATE subscribers SET status = 'confirmed', confirmed_at = ?, confirmed_hash = confirm_hash, confirm_hash = NULL, updated_at = ? WHERE confirm_hash = ? AND status = 'pending' AND confirm_sent_at >= ?",
  )
    .bind(now, now, await sha256(token), now - CONFIRM_VALID_FOR)
    .run();
  if (!result.meta.changes) return expiredPage();
  return page("You're subscribed", "You're subscribed. We'll email you about new Seira features and tips, about twice a month.");
}

async function unsubscribe(request: Request, env: AppEnv, url: URL) {
  const done = () => page("Unsubscribed", "You're unsubscribed. You won't get Seira updates anymore.");
  if (request.method === "GET") {
    const token = url.searchParams.get("t") ?? "";
    return page("Unsubscribe from Seira updates", "Press the button to stop Seira updates.", {
      action: `/unsubscribe?t=${encodeURIComponent(token)}`,
      button: "Unsubscribe",
    });
  }
  if (request.method !== "POST") return methodNotAllowed();
  const token = url.searchParams.get("t") ?? (await formValue(request, "t")) ?? "";
  if (TOKEN_PATTERN.test(token)) await unsubscribeStatement(env, "unsubscribe_token", token, nowSeconds()).run();
  return done();
}

async function authorized(request: Request, env: AppEnv) {
  const header = request.headers.get("Authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const sameGiven = await sameSecret(given, env.ADMIN_TOKEN || "unset");
  return Boolean(env.ADMIN_TOKEN) && Boolean(given) && sameGiven;
}

async function stats(env: AppEnv) {
  const { results } = await env.DB.prepare("SELECT status, COUNT(*) AS total FROM subscribers GROUP BY status").all<{ status: string; total: number }>();
  const counts = { pending: 0, confirmed: 0, unsubscribed: 0 };
  for (const row of results) if (row.status in counts) counts[row.status as keyof typeof counts] = row.total;
  return json(counts);
}

const singleLine = (value: unknown, max: number) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\r\n]/.test(value) ? value : null;

async function adminSend(request: Request, env: AppEnv) {
  const body = await readJson(request, 400_000);
  if (!isRecord(body)) return invalidRequest();
  const subject = singleLine(body.subject, 200);
  const text = typeof body.text === "string" && body.text.trim() ? body.text : null;
  const html = body.html === undefined ? undefined : typeof body.html === "string" && body.html.trim() ? body.html : null;
  const test = body.test === undefined ? undefined : normalizeEmail(body.test);
  const after = body.after === undefined ? "" : typeof body.after === "string" ? body.after : null;
  const limit = body.limit === undefined ? DEFAULT_BATCH : body.limit;
  if (
    !subject || !text || html === null || test === null || after === null ||
    typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH
  ) {
    return invalidRequest();
  }

  const failed: Array<{ email: string; code: string }> = [];
  let sent = 0;
  const deliver = async (to: string, unsubscribeToken?: string) => {
    try {
      await env.EMAIL.send(updateMessage(env, { to, subject, text, html, unsubscribeToken }));
      sent += 1;
    } catch (error) {
      failed.push({ email: to, code: errorCode(error) });
    }
  };

  if (test) {
    await deliver(test);
    return json({ sent, failed, next: null });
  }
  const { results } = await env.DB.prepare(
    "SELECT email, unsubscribe_token FROM subscribers WHERE status = 'confirmed' AND email > ? ORDER BY email LIMIT ?",
  )
    .bind(after, limit)
    .all<{ email: string; unsubscribe_token: string }>();
  for (const row of results) await deliver(row.email, row.unsubscribe_token);
  return json({ sent, failed, next: results.length === limit ? results[results.length - 1]!.email : null });
}

async function admin(request: Request, env: AppEnv, pathname: string) {
  if (!(await authorized(request, env))) return json({ error: "unauthorized" }, 401);
  if (pathname === "/admin/stats") return request.method === "GET" ? stats(env) : methodNotAllowed();
  return request.method === "POST" ? adminSend(request, env) : methodNotAllowed();
}

async function route(request: Request, env: AppEnv) {
  const url = new URL(request.url);
  switch (url.pathname) {
    case "/":
      return Response.redirect(env.SITE_URL, 302);
    case "/api/updates-consent":
      return updatesConsent(request, env);
    case "/confirm":
      return confirm(request, env, url);
    case "/unsubscribe":
      return unsubscribe(request, env, url);
    case "/admin/stats":
    case "/admin/send":
      return admin(request, env, url.pathname);
    default:
      return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      console.error("unhandled", error instanceof Error ? error.name : "unknown");
      return json({ error: "server_error" }, 500);
    }
  },
};
