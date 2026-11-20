import { afterEach, describe, expect, it, vi } from "vitest";

import { handle } from "./index";
import { forgetFcmAccessToken } from "./push-fcm";
import { APNS_TOKEN, apnsPem, FCM_DEVICE, harness, NOTIFICATION, TEST_IP } from "./test-harness";

const ROUTES: Array<[string, string]> = [
  ["GET", "/healthz"],
  ["POST", "/v1/push/enroll"],
  ["POST", "/v1/installations/self/push/register"],
  ["POST", "/v1/installations/self/push/unregister"],
  ["POST", "/v1/installations/self/push/send"],
  ["POST", "/v1/installations/self/push/activity"],
  ["POST", "/v1/installations/self/credentials/rotate"],
  ["DELETE", "/v1/installations/self"],
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("routing", () => {
  it("AC-25: answers 403 forbidden to a request with an Origin header, on every route, and does nothing else", async () => {
    const h = harness();
    const { credential } = await h.install();
    const queries = h.d1.sqlLog.length;
    for (const [method, path] of [...ROUTES, ["GET", "/nothing"] as [string, string]]) {
      for (const auth of [undefined, credential]) {
        const response = await h.call(method, path, { credential: auth, body: method === "POST" ? { v: 1 } : undefined, headers: { origin: "https://evil.example" } });
        expect(response.status, `${method} ${path}`).toBe(403);
        expect(await response.json()).toEqual({ error: "forbidden" });
      }
    }
    expect(h.d1.sqlLog).toHaveLength(queries);
    expect(h.providers.calls).toHaveLength(0);
  });

  it("answers healthz with the service name and whether each platform is configured", async () => {
    for (const [options, apns, fcm] of [[{}, true, true], [{ apns: false }, false, true], [{ fcm: false }, true, false], [{ apns: false, fcm: false }, false, false]] as const) {
      const h = harness(options);
      const response = await h.call("GET", "/healthz");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, service: "seira-push", apns, fcm });
    }
  });

  it("answers 404 not_found for an unknown path", async () => {
    const h = harness();
    for (const path of ["/", "/v1", "/v1/installations/self/push", "/v1/installations/other", "/constructor", "/__proto__"]) {
      const response = await h.call("GET", path);
      expect(response.status, path).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
  });

  it("answers 405 for the wrong method on a known route", async () => {
    const h = harness();
    for (const [method, path] of [["POST", "/healthz"], ["GET", "/v1/push/enroll"], ["GET", "/v1/installations/self/push/send"], ["POST", "/v1/installations/self"], ["DELETE", "/v1/push/enroll"]]) {
      const response = await h.call(method!, path!);
      expect(response.status, `${method} ${path}`).toBe(405);
    }
  });

  it("answers 400 invalid_request for a body over 16 KB or a body that is not JSON, and sets cache-control no-store", async () => {
    const h = harness();
    const { credential } = await h.install();
    const big = await h.call("POST", "/v1/installations/self/push/register", { credential, body: { v: 1, token: APNS_TOKEN, environment: "production", pad: "x".repeat(17 * 1024) } });
    expect(big.status).toBe(400);
    expect(await big.json()).toEqual({ error: "invalid_request" });
    const chunked = await h.call("POST", "/v1/installations/self/push/register", { credential, body: "x".repeat(17 * 1024) });
    expect(chunked.status).toBe(400);
    const bad = await h.call("POST", "/v1/installations/self/push/register", { credential, body: "{nope" });
    expect(bad.status).toBe(400);
    for (const response of [big, bad, await h.call("GET", "/healthz"), await h.call("GET", "/nothing")]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toContain("application/json");
    }
  });

  it("answers 429 with retry-after 60 when the request limiter refuses, on every route except healthz, keyed by the /64", async () => {
    const h = harness();
    h.limits.request = false;
    for (const [method, path] of ROUTES.slice(1)) {
      const response = await h.call(method, path, { ip: "2001:db8:5:6:7:8:9:a" });
      expect(response.status, path).toBe(429);
      expect(response.headers.get("retry-after")).toBe("60");
    }
    expect(new Set(h.limits.requestKeys)).toEqual(new Set(["2001:db8:5:6::/64"]));
    expect((await h.call("GET", "/healthz")).status).toBe(200);
  });
});

describe("logs", () => {
  function spies() {
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
      });
    }
    return lines;
  }

  it("AC-26: writes no credential, token, IP address, title, or key to a log, through failing sends, a 401, and an unhandled error", async () => {
    const lines = spies();
    const h = harness();
    const ip = "203.0.113.55";
    const { credential } = await h.install(ip);
    await h.registerApns(credential);
    await h.registerFcm(credential);
    h.providers.queues.apns.push({ status: 500, body: { reason: "InternalServerError" } });
    expect((await h.send(credential, APNS_TOKEN)).status).toBe(502);
    h.providers.queues.fcm.push({ status: 500, body: { error: { status: "INTERNAL", message: "x" } } });
    expect((await h.send(credential, FCM_DEVICE)).status).toBe(502);
    h.providers.queues.apns.push({ status: 403, body: { reason: "InvalidProviderToken" } }, { status: 403, body: { reason: "InvalidProviderToken" } });
    expect((await h.send(credential, APNS_TOKEN)).status).toBe(503);
    forgetFcmAccessToken();
    h.providers.queues.oauth.push({ status: 400, body: { error: "invalid_grant" } });
    expect((await h.send(credential, FCM_DEVICE)).status).toBe(503);
    expect((await h.send(`seira_install_${"A".repeat(22)}.${"B".repeat(43)}`, APNS_TOKEN)).status).toBe(401);
    const broken = { ...h.env, DB: { prepare: () => { throw new Error(`boom ${credential} ${ip}`); }, batch: () => { throw new Error("boom"); } } as unknown as D1Database };
    const failed = await handle(
      new Request("https://push.test/v1/installations/self/push/send", {
        method: "POST",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({ v: 1, token: APNS_TOKEN, notification: NOTIFICATION }),
      }),
      broken,
      h.deps,
    );
    expect(failed.status).toBe(500);

    expect(lines.length).toBeGreaterThan(0);
    const secret = /^seira_install_[^.]+\.(.+)$/.exec(credential)![1]!;
    const privateBits = apnsPem.split("\n")[1]!;
    for (const line of lines) {
      for (const text of [credential, secret, APNS_TOKEN, FCM_DEVICE, ip, TEST_IP, NOTIFICATION.title, NOTIFICATION.botId, "Hidden Bot Name", privateBits, "Bearer", "ya29"]) {
        expect(line, text).not.toContain(text);
      }
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(parsed).every((key) => ["message", "status", "platform", "reason"].includes(key))).toBe(true);
    }
  });

  it("AC-26: writes nothing to a log for a send that succeeds", async () => {
    const lines = spies();
    const h = harness();
    const { credential } = await h.install();
    await h.registerApns(credential);
    expect((await h.send(credential, APNS_TOKEN)).status).toBe(202);
    expect(lines).toEqual([]);
  });
});
