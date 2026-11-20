import { describe, expect, it, vi } from "vitest";

import { createControlPlaneClient } from "./control-plane-client.mjs";
import { createSeiraCloudSignIn, seiraCloudSignInOrigin } from "./seira-cloud-sign-in.mjs";

const CONTROL_PLANE = "https://control.example.test";
const CLOUD = "https://cloud.example.test";
const ATTEMPT = "A".repeat(43);
const TOKEN = `omc_${"b".repeat(43)}`;
const BETTER_AUTH_TOKEN = `signed.${"a".repeat(40)}`;
const json = (body, init = {}) =>
  new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { "content-type": "application/json", ...init.headers } });

function fixture({ accounts = "seira-cloud", verify } = {}) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    const { pathname } = new URL(url);
    calls.push({ method: init.method, url, path: pathname, body, authorization: init.headers.get("authorization") });
    if (url === `${CONTROL_PLANE}/healthz`) {
      return json({ ok: true, service: "seira-control-plane", ...(accounts ? { accounts } : {}) });
    }
    if (pathname === "/api/cloud/app/sign-in/start") {
      return json({ cloudContractVersion: 1, attempt: ATTEMPT, expiresIn: 600, resendAfter: 30, signupOpen: true });
    }
    if (pathname === "/api/cloud/app/sign-in/verify") {
      return verify?.() ?? json({ accessToken: TOKEN, expiresAt: 1, device: { id: "dev" }, account: { id: "acct_1", email: "ada@example.com" } });
    }
    if (pathname === "/api/cloud/desktop/session") return new Response(null, { status: 204 });
    if (pathname === "/api/auth/email-otp/send-verification-otp") return json({ success: true });
    if (pathname === "/api/auth/sign-in/email-otp") {
      return json({ user: { id: "user-1", email: "ada@example.com" } }, { headers: { "set-auth-token": BETTER_AUTH_TOKEN } });
    }
    if (pathname === "/api/auth/sign-out") return json({ success: true });
    return json({ error: "not_found" }, { status: 404 });
  });
  const cloudSignIn = createSeiraCloudSignIn({
    origin: CLOUD,
    identity: { deviceName: "box-1", platform: "linux", appVersion: "1.2.3" },
    fetchImpl,
  });
  const client = createControlPlaneClient({ baseURL: CONTROL_PLANE, fetchImpl, cloudSignIn });
  return { client, calls, fetchImpl };
}

describe("sign-in through Seira Cloud", () => {
  it("reads who holds the accounts from the health answer", async () => {
    expect(await fixture().client.accounts()).toBe("seira-cloud");
    expect(await fixture({ accounts: "better-auth" }).client.accounts()).toBe("better-auth");
    expect(await fixture({ accounts: null }).client.accounts()).toBe("better-auth");
    await expect(fixture({ accounts: "seira-cloud" }).client.health()).resolves.toBe(true);
  });

  it("starts with the device facts, then verifies with the attempt", async () => {
    const { client, calls } = fixture();
    await expect(client.requestOTP(" Ada@Example.com ")).resolves.toEqual({ email: "ada@example.com" });
    const start = calls.find((call) => call.path === "/api/cloud/app/sign-in/start");
    expect(start).toMatchObject({ method: "POST", url: `${CLOUD}/api/cloud/app/sign-in/start`, body: { email: "ada@example.com", deviceName: "box-1", platform: "linux", appVersion: "1.2.3" } });
    expect(calls.some((call) => call.path.startsWith("/api/auth/"))).toBe(false);

    await expect(client.verifyOTP("ada@example.com", "1234 5678")).resolves.toEqual({
      accountToken: TOKEN,
      user: { id: "acct_1", email: "ada@example.com" },
    });
    expect(calls.find((call) => call.path === "/api/cloud/app/sign-in/verify").body).toEqual({ attempt: ATTEMPT, code: "12345678" });
  });

  it("uses the Better Auth routes when the health answer has no accounts field", async () => {
    const { client, calls } = fixture({ accounts: null });
    await client.requestOTP("ada@example.com");
    expect(calls.some((call) => call.path === "/api/auth/email-otp/send-verification-otp")).toBe(true);
    expect(calls.some((call) => call.path.startsWith("/api/cloud/"))).toBe(false);
    await expect(client.verifyOTP("ada@example.com", "12345678")).resolves.toMatchObject({ accountToken: BETTER_AUTH_TOKEN });
  });

  it("revokes only a Seira Cloud token at Seira Cloud", async () => {
    const { client, calls } = fixture();
    await client.signOut(TOKEN);
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", url: `${CLOUD}/api/cloud/desktop/session`, authorization: `Bearer ${TOKEN}` });
    await client.signOut(BETTER_AUTH_TOKEN);
    expect(calls.at(-1).path).toBe("/api/auth/sign-out");
  });

  it("maps refusals to plain codes", async () => {
    const wrong = fixture({ verify: () => json({ error: "invalid_code" }, { status: 400 }) });
    await wrong.client.requestOTP("ada@example.com");
    await expect(wrong.client.verifyOTP("ada@example.com", "12345678")).rejects.toMatchObject({ code: "invalid_otp" });

    const full = fixture({ verify: () => json({ error: "device_limit" }, { status: 403 }) });
    await full.client.requestOTP("ada@example.com");
    await expect(full.client.verifyOTP("ada@example.com", "12345678")).rejects.toMatchObject({ code: "device_limit" });

    const bad = fixture();
    await bad.client.requestOTP("ada@example.com");
    await expect(bad.client.verifyOTP("ada@example.com", "123")).rejects.toMatchObject({ code: "invalid_otp" });
    await expect(bad.client.verifyOTP("other@example.com", "12345678")).rejects.toMatchObject({ code: "otp_expired" });
  });

  it("cuts a long host name and names an unknown platform linux", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return json({ cloudContractVersion: 1, attempt: ATTEMPT, expiresIn: 600, resendAfter: 30 });
    });
    const signIn = createSeiraCloudSignIn({ origin: CLOUD, identity: { deviceName: `${"h".repeat(150)}\n`, platform: "freebsd", appVersion: "not a version" }, fetchImpl });
    await signIn.start("ada@example.com");
    expect(calls[0].deviceName).toHaveLength(100);
    expect(calls[0]).toMatchObject({ platform: "linux", appVersion: "0.0.0" });
  });

  it("reads the Seira Cloud address from the environment, else Seira's own", () => {
    expect(seiraCloudSignInOrigin({})).toBe("https://cloud.seira.bot");
    expect(seiraCloudSignInOrigin({ SEIRA_CLOUD_ORIGIN: "https://cloud.example.test" })).toBe("https://cloud.example.test");
    expect(seiraCloudSignInOrigin({ SEIRA_CLOUD_ORIGIN: "http://cloud.example.test" })).toBe("https://cloud.seira.bot");
  });
});
