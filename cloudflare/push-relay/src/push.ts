import type { z } from "zod";

import { DAY_MS, HTTPError, errorResponse, json, logFailure, noContent, readJson, sha256Hex } from "./common";
import { deliverApns, deliverFcm, type Delivery } from "./delivery";
import type { AppEnv, Deps } from "./env";
import type { Caller } from "./installations";
import { bump, daily, hourly, limitVar, takeAll } from "./limits";
import { apnsPayload, collapseIdOf, fcmPayload, registerSchema, sendSchema, unregisterSchema } from "./payload";
import { readApnsConfig, type ApnsEnvironment } from "./push-apns";
import { readFcmConfig } from "./push-fcm";

export type PushPlatform = "apns" | "fcm";
export type PushPurpose = "alert" | "activity" | "activity-start";

export const PUSH_DEVICE_LIMIT = 50;
export const PUSH_REGISTER_LIMIT = 120;
export const PUSH_SEND_LIMIT = 600;
export const PUSH_DEVICE_SEND_LIMIT = 60;
/** Dead-token answers in one hour that block an installation for a day. */
export const DEAD_TOKEN_LIMIT = 20;

export const unavailable = () => new HTTPError(503, "push_unavailable");

async function parse<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readJson(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  return parsed.data;
}

export async function registerDevice(request: Request, caller: Caller, env: AppEnv, deps: Deps): Promise<Response> {
  const body = await parse(request, registerSchema);
  const platform: PushPlatform = body.platform ?? "apns";
  const environment: ApnsEnvironment = body.environment ?? "production";
  const purpose: PushPurpose = body.platform === "fcm" ? "alert" : (body.purpose ?? "alert");
  if (platform === "fcm") {
    if (!readFcmConfig(env)) throw unavailable();
  } else {
    const apns = readApnsConfig(env);
    if (!apns) throw unavailable();
    if (!apns.environments.has(environment)) throw new HTTPError(400, "push_environment_not_allowed");
  }
  const now = deps.now();
  await takeAll(env, [hourly(`inst:${caller.installationId}`, "register", PUSH_REGISTER_LIMIT)], now);
  const tokenHash = await sha256Hex(body.token);
  const [updated, inserted] = await env.DB.batch([
    env.DB.prepare(
      "UPDATE push_devices SET platform = ?, environment = ?, purpose = ?, updated_at = ? WHERE installation_id = ? AND token_hash = ?",
    ).bind(platform, environment, purpose, now, caller.installationId, tokenHash),
    env.DB.prepare(
      `INSERT INTO push_devices (installation_id, token_hash, platform, token, environment, purpose, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM push_devices WHERE installation_id = ?) < ?
       ON CONFLICT(installation_id, token_hash) DO NOTHING`,
    ).bind(caller.installationId, tokenHash, platform, body.token, environment, purpose, now, now, caller.installationId, PUSH_DEVICE_LIMIT),
  ]);
  if (updated?.meta.changes === 0 && inserted?.meta.changes === 0) throw new HTTPError(409, "push_device_limit");
  return json({ registered: true });
}

export async function unregisterDevice(request: Request, caller: Caller, env: AppEnv): Promise<Response> {
  const body = await parse(request, unregisterSchema);
  await env.DB.prepare("DELETE FROM push_devices WHERE installation_id = ? AND token_hash = ?")
    .bind(caller.installationId, await sha256Hex(body.token))
    .run();
  return noContent();
}

interface DeviceRow {
  token: string;
  platform: PushPlatform;
  environment: ApnsEnvironment;
  purpose: PushPurpose;
}

export async function sendPush(request: Request, caller: Caller, env: AppEnv, deps: Deps): Promise<Response> {
  const body = await parse(request, sendSchema);
  const now = deps.now();
  if (caller.blockedUntil !== null && caller.blockedUntil > now) {
    throw new HTTPError(429, "rate_limited", Math.max(1, Math.ceil((caller.blockedUntil - now) / 1000)));
  }
  const tokenHash = await sha256Hex(body.token);
  // Only a token this installation registered, so a credential cannot be pointed at the phone of somebody else.
  const row = await env.DB.prepare(
    "SELECT token, platform, environment, purpose FROM push_devices WHERE installation_id = ? AND token_hash = ?",
  )
    .bind(caller.installationId, tokenHash)
    .first<DeviceRow>();
  if (!row || row.token !== body.token || row.purpose !== "alert") return errorResponse(404, "push_device_unknown");

  const apns = row.platform === "apns" ? readApnsConfig(env) : null;
  const fcm = row.platform === "fcm" ? readFcmConfig(env) : null;
  if (!apns && !fcm) return errorResponse(503, "push_unavailable");

  const installation = `inst:${caller.installationId}`;
  await takeAll(
    env,
    [
      hourly(installation, "send", PUSH_SEND_LIMIT),
      hourly(installation, `send:${tokenHash}`, PUSH_DEVICE_SEND_LIMIT),
      daily(`token:${tokenHash}`, "send", limitVar(env.TOKEN_DAILY, 300)),
      hourly("global", "send", limitVar(env.SEND_GLOBAL_HOURLY, 20000)),
    ],
    now,
  );

  const collapseId = await collapseIdOf(body);
  const outcome: Delivery = apns
    ? await deliverApns(apns, row.environment, body.token, apnsPayload(body), collapseId, deps.fetch, now)
    : await deliverFcm(fcm!, fcmPayload(body, body.token, collapseId), deps.fetch, now);

  if (outcome.kind === "sent") {
    await env.DB.prepare("UPDATE push_devices SET last_sent_at = ? WHERE installation_id = ? AND token_hash = ?").bind(now, caller.installationId, tokenHash).run();
    return json({ sent: true }, 202);
  }
  if (outcome.kind === "dead") {
    // APNs judges a token per environment and topic, and a 410 timestamp spares registrations made after it.
    // FCM judges a token for its one project.
    await (row.platform === "fcm"
      ? env.DB.prepare("DELETE FROM push_devices WHERE token_hash = ? AND platform = 'fcm'").bind(tokenHash)
      : env.DB.prepare("DELETE FROM push_devices WHERE token_hash = ? AND platform = 'apns' AND environment = ? AND updated_at <= ?").bind(
          tokenHash,
          row.environment,
          Math.min(outcome.invalidSince ?? now, now),
        )
    ).run();
    if ((await bump(env, hourly(installation, "dead_token", DEAD_TOKEN_LIMIT), now)) >= DEAD_TOKEN_LIMIT) {
      await env.DB.prepare("UPDATE installations SET blocked_until = ? WHERE id = ?").bind(now + DAY_MS, caller.installationId).run();
    }
    return errorResponse(410, "push_device_unregistered");
  }
  logFailure({ message: `${row.platform} push failed`, status: outcome.status, platform: row.platform, reason: outcome.reason });
  if (outcome.kind === "throttled") return errorResponse(429, "rate_limited", 60);
  if (outcome.kind === "credentials") return errorResponse(503, "push_unavailable");
  return errorResponse(502, "push_failed");
}

/** Live Activity and ongoing notifications. A later change builds this. */
export function activity(): Response {
  return errorResponse(503, "push_unavailable");
}
