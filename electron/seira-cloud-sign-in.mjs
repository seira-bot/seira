import { ControlPlaneError } from "./control-plane-client.mjs";
import {
  cleanCode,
  cleanEmail,
  parseSignInStart,
  SIGN_IN_START,
  SIGN_IN_VERIFY,
  signInIdentity,
  startFailure,
  verifyFailure,
} from "./cloud-signin.mjs";
import { SEIRA_HOSTS, seiraOrigin } from "./seira-hosts.mjs";

const SESSION_PATH = "/api/cloud/desktop/session";
const TOKEN = /^omc_[A-Za-z0-9_-]{43}$/;
const DEVICE_NAME_MAX = 100;
const REQUEST_MS = 15_000;
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/g;

/** An https origin, or http on 127.0.0.1; null for anything else. */
function originOf(value) {
  if (typeof value !== "string" || value.length > 253) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (value !== url.origin || url.username || url.password) return null;
  return url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1") ? value : null;
}

/** The Seira Cloud that signs people in: SEIRA_CLOUD_ORIGIN when valid, else Seira's own. */
export function seiraCloudSignInOrigin(env = process.env) {
  return originOf(env?.SEIRA_CLOUD_ORIGIN) ?? seiraOrigin(SEIRA_HOSTS.cloud);
}

/** Host name and platform in the form Seira Cloud accepts for a device. */
function cloudIdentity({ deviceName, platform, appVersion }) {
  const name = typeof deviceName === "string" ? deviceName.replace(CONTROL, " ").trim().slice(0, DEVICE_NAME_MAX).trim() : "";
  return signInIdentity({
    deviceName: name || "Seira server",
    platform: ["darwin", "win32", "linux"].includes(platform) ? platform : "linux",
    appVersion,
  });
}

const START_CODES = Object.freeze({
  sso: ["sign_in_unavailable", 403],
  "rate-limited": ["rate_limited", 429],
  browser: ["sign_in_unavailable", 404],
  "invalid-email": ["invalid_email", 400],
  failed: ["request_failed", 0],
});

const VERIFY_CODES = Object.freeze({
  "wrong-code": ["invalid_otp", 400],
  expired: ["otp_expired", 410],
  sso: ["sign_in_unavailable", 403],
  "two-factor": ["sign_in_unavailable", 403],
  "signup-closed": ["signup_closed", 403],
  "device-limit": ["device_limit", 403],
  "rate-limited": ["rate_limited", 429],
  browser: ["sign_in_unavailable", 404],
  failed: ["request_failed", 0],
});

/** Email-code sign-in against Seira Cloud. The attempt stays in this object. Failures are ControlPlaneErrors. */
export function createSeiraCloudSignIn({
  origin,
  identity,
  fetchImpl = globalThis.fetch,
  timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
}) {
  const base = originOf(origin);
  if (!base) throw new ControlPlaneError("control_plane_unavailable");
  let pending = null;

  const send = async (path, { method = "POST", body, token } = {}) => {
    const headers = new Headers({ accept: "application/json" });
    if (token) headers.set("authorization", `Bearer ${token}`);
    if (body !== undefined) headers.set("content-type", "application/json");
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        redirect: "error",
        signal: timeoutSignal(REQUEST_MS),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ControlPlaneError("network_unavailable");
    }
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const code = typeof payload?.error === "string" ? payload.error : undefined;
      const said = { status: response.status, code, opaque: code === undefined };
      return { failed: said, retryAfter: response.headers.get("retry-after") };
    }
    return { payload };
  };

  const fail = (table, word, failed, retryAfter) => {
    const [code, status] = table[word] ?? table.failed;
    const seconds = /^[0-9]{1,6}$/.test(retryAfter ?? "") ? Number(retryAfter) * 1_000 : 0;
    return new ControlPlaneError(code, failed.status || status, "", seconds);
  };

  return {
    async start(rawEmail) {
      const email = cleanEmail(rawEmail);
      const who = cloudIdentity(identity ?? {});
      if (!email) throw new ControlPlaneError("invalid_email");
      if (!who) throw new ControlPlaneError("request_failed");
      pending = null;
      const result = await send(SIGN_IN_START, { body: { email, ...who } });
      if (result.failed) throw fail(START_CODES, startFailure(result.failed), result.failed, result.retryAfter);
      const started = parseSignInStart(result.payload);
      if (!started) throw new ControlPlaneError("invalid_response");
      pending = { attempt: started.attempt, email };
      return { email };
    },

    async verify(rawEmail, rawCode) {
      const email = cleanEmail(rawEmail);
      const code = cleanCode(rawCode);
      if (!email) throw new ControlPlaneError("invalid_email");
      if (!code) throw new ControlPlaneError("invalid_otp");
      if (!pending || pending.email !== email) throw new ControlPlaneError("otp_expired");
      const result = await send(SIGN_IN_VERIFY, { body: { attempt: pending.attempt, code } });
      if (result.failed) {
        const word = verifyFailure(result.failed);
        if (word === "expired") pending = null;
        throw fail(VERIFY_CODES, word, result.failed, result.retryAfter);
      }
      const { accessToken, account } = result.payload ?? {};
      if (
        typeof accessToken !== "string" ||
        !TOKEN.test(accessToken) ||
        typeof account?.id !== "string" ||
        !account.id ||
        account.id.length > 256 ||
        typeof cleanEmail(account.email) !== "string"
      ) {
        throw new ControlPlaneError("invalid_response");
      }
      pending = null;
      return { accountToken: accessToken, user: { id: account.id, email: cleanEmail(account.email) } };
    },

    async signOut(token) {
      if (typeof token !== "string" || !TOKEN.test(token)) return;
      const result = await send(SESSION_PATH, { method: "DELETE", token });
      if (result.failed) throw new ControlPlaneError("request_failed", result.failed.status);
    },
  };
}
