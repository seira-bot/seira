import { APNS_HOSTS, apnsProviderToken, forgetApnsToken, type ApnsConfig, type ApnsEnvironment } from "./push-apns";
import { FCM_TIMEOUT, fcmAccessToken, fcmSendUrl, fcmTokenIsDead, forgetFcmAccessToken, readFcmError, type FcmConfig } from "./push-fcm";

export type Delivery =
  | { kind: "sent" }
  | { kind: "dead"; invalidSince?: number }
  | { kind: "throttled" | "credentials" | "failed"; status: number; reason: string };

const APNS_EXPIRATION_SECONDS = 24 * 60 * 60;
const APNS_TIMEOUT_MS = 10_000;
const DEAD_TOKEN_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"]);
const PROVIDER_TOKEN_REASONS = new Set(["ExpiredProviderToken", "InvalidProviderToken", "MissingProviderToken"]);

export async function deliverApns(
  config: ApnsConfig,
  environment: ApnsEnvironment,
  token: string,
  body: unknown,
  collapseId: string,
  apnsFetch: typeof fetch,
  now: number,
): Promise<Delivery> {
  const payload = JSON.stringify(body);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let providerToken: string;
    try {
      providerToken = await apnsProviderToken(config, now);
    } catch {
      return { kind: "credentials", status: 0, reason: "invalid signing key" };
    }
    let response: Response;
    try {
      response = await apnsFetch(`${APNS_HOSTS[environment]}/3/device/${token}`, {
        method: "POST",
        headers: {
          authorization: `bearer ${providerToken}`,
          "apns-topic": config.bundleId,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-expiration": String(Math.floor(now / 1_000) + APNS_EXPIRATION_SECONDS),
          "apns-collapse-id": collapseId,
          "content-type": "application/json",
        },
        body: payload,
        redirect: "manual",
        signal: AbortSignal.timeout(APNS_TIMEOUT_MS),
      });
    } catch {
      return { kind: "failed", status: 0, reason: "unreachable" };
    }
    if (response.status === 200) return { kind: "sent" };
    const answer = (await response.json().catch(() => null)) as { reason?: unknown; timestamp?: unknown } | null;
    const reason = typeof answer?.reason === "string" ? answer.reason.slice(0, 64) : "";
    if (response.status === 410) {
      const invalidSince = typeof answer?.timestamp === "number" && Number.isFinite(answer.timestamp) ? answer.timestamp : undefined;
      return { kind: "dead", invalidSince };
    }
    if (DEAD_TOKEN_REASONS.has(reason)) return { kind: "dead" };
    if (response.status === 403 && PROVIDER_TOKEN_REASONS.has(reason) && attempt === 0) {
      forgetApnsToken();
      continue;
    }
    if (response.status === 403) return { kind: "credentials", status: 403, reason };
    if (response.status === 429) return { kind: "throttled", status: 429, reason };
    return { kind: "failed", status: response.status, reason };
  }
  return { kind: "credentials", status: 403, reason: "provider token refused twice" };
}

export async function deliverFcm(config: FcmConfig, body: unknown, pushFetch: typeof fetch, now: number): Promise<Delivery> {
  const payload = JSON.stringify(body);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const access = await fcmAccessToken(config, pushFetch, now);
    if (access.kind !== "ok") return access;
    let response: Response;
    try {
      response = await pushFetch(fcmSendUrl(config), {
        method: "POST",
        headers: { authorization: `Bearer ${access.token}`, "content-type": "application/json" },
        body: payload,
        redirect: "manual",
        signal: AbortSignal.timeout(FCM_TIMEOUT),
      });
    } catch {
      return { kind: "failed", status: 0, reason: "unreachable" };
    }
    if (response.status === 200) return { kind: "sent" };
    const error = await readFcmError(response);
    if (fcmTokenIsDead(error)) return { kind: "dead" };
    if (response.status === 401 && attempt === 0) {
      forgetFcmAccessToken();
      continue;
    }
    if (response.status === 401 || response.status === 403) return { kind: "credentials", status: response.status, reason: error.errorCode };
    if (response.status === 429) return { kind: "throttled", status: 429, reason: error.errorCode };
    return { kind: "failed", status: response.status, reason: error.errorCode };
  }
  return { kind: "credentials", status: 401, reason: "access token refused twice" };
}
