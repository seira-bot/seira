import { describe, expect, it } from "vitest";

import { collapseIdOf, KIND_PRESENTATION } from "./payload";
import { APNS_TOKEN, harness, NOTIFICATION, OTHER_APNS_TOKEN } from "./test-harness";

const HOUR_MS = 3_600_000;
const hexToken = (n: number) => n.toString(16).padStart(64, "0");

async function registered(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  const mine = await h.install();
  expect((await h.registerApns(mine.credential)).status).toBe(200);
  return { h, ...mine };
}

describe("register and unregister", () => {
  it("AC-05: stores a valid APNs token for the installation and answers 200", async () => {
    const h = harness();
    const { credential, installationId } = await h.install();
    const response = await h.registerApns(credential);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ registered: true });
    expect(h.devices()).toMatchObject([{ installation_id: installationId, platform: "apns", token: APNS_TOKEN }]);
    expect((await h.registerApns(credential)).status).toBe(200);
    expect(h.devices()).toHaveLength(1);
  });

  it("AC-05: refuses a token or body of the wrong shape with 400", async () => {
    const h = harness();
    const { credential } = await h.install();
    for (const body of [{ v: 1, token: "short", environment: "production" }, { v: 1, token: APNS_TOKEN }, { v: 2, token: APNS_TOKEN, environment: "production" }, { v: 1, token: APNS_TOKEN, environment: "production", extra: 1 }]) {
      expect((await h.register(credential, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(h.devices()).toHaveLength(0);
  });

  it("AC-05: answers 400 push_environment_not_allowed for an environment the relay does not allow", async () => {
    const h = harness({ env: { APNS_ENVIRONMENTS: "production" } });
    const { credential } = await h.install();
    const response = await h.registerApns(credential, APNS_TOKEN, "sandbox");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "push_environment_not_allowed" });
  });

  it("AC-06: deletes the token for that installation and answers 204, also when the token is not stored", async () => {
    const h = harness();
    const mine = await h.install();
    const other = await h.install();
    await h.registerApns(mine.credential);
    await h.registerApns(other.credential);
    const first = await h.unregister(mine.credential, { v: 1, token: APNS_TOKEN });
    expect(first.status).toBe(204);
    expect(h.devices().map((device) => device.installation_id)).toEqual([other.installationId]);
    expect((await h.unregister(mine.credential, { v: 1, token: APNS_TOKEN })).status).toBe(204);
    expect((await h.unregister(mine.credential, { v: 1, token: OTHER_APNS_TOKEN })).status).toBe(204);
  });

  it("AC-07: answers 503 push_unavailable for register, send, and activity when the relay holds no APNs secrets", async () => {
    const h = harness({ apns: false });
    const { credential } = await h.install();
    const register = await h.registerApns(credential);
    expect(register.status).toBe(503);
    expect(await register.json()).toEqual({ error: "push_unavailable" });
    expect(h.devices()).toHaveLength(0);

    const { h: held, credential: heldCredential } = await registered();
    delete held.env.APNS_PRIVATE_KEY;
    const send = await held.send(heldCredential, APNS_TOKEN);
    expect(send.status).toBe(503);
    expect(await send.json()).toEqual({ error: "push_unavailable" });
    const activity = await held.call("POST", "/v1/installations/self/push/activity", { credential: heldCredential, body: {} });
    expect(activity.status).toBe(503);
    expect(held.providers.calls).toHaveLength(0);
  });

  it("answers 503 push_unavailable for the activity route after a valid credential", async () => {
    const { h, credential } = await registered();
    const response = await h.call("POST", "/v1/installations/self/push/activity", { credential, body: { v: 1 } });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "push_unavailable" });
    expect(h.providers.calls).toHaveLength(0);
  });

  it("answers 409 push_device_limit for the 51st token, and still accepts a token already stored", async () => {
    const h = harness();
    const { credential } = await h.install();
    for (let n = 1; n <= 50; n += 1) expect((await h.registerApns(credential, hexToken(n))).status).toBe(200);
    const refused = await h.registerApns(credential, hexToken(51));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "push_device_limit" });
    expect((await h.registerApns(credential, hexToken(1))).status).toBe(200);
    expect(h.devices()).toHaveLength(50);
  });

  it("answers 429 after 120 registers in an hour", async () => {
    const h = harness();
    const { credential } = await h.install();
    for (let n = 0; n < 120; n += 1) expect((await h.registerApns(credential)).status).toBe(200);
    const refused = await h.registerApns(credential);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("3600");
  });
});

describe("send to APNs", () => {
  it("AC-08: sends one alert with the headers and the exact body keys of payload version 1", async () => {
    const { h, credential } = await registered();
    const response = await h.send(credential, APNS_TOKEN, {}, { collapseId: "bot_1:req_1", pairing: "pair-0001" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ sent: true });
    const [call, ...rest] = h.providers.apns();
    expect(rest).toHaveLength(0);
    expect(call!.url).toBe(`https://api.push.apple.com/3/device/${APNS_TOKEN}`);
    expect(call!.headers).toMatchObject({
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-topic": "bot.seira.test",
      "apns-collapse-id": "bot_1:req_1",
      "apns-expiration": String(Math.floor(h.clock.ms / 1000) + 86400),
    });
    expect(call!.headers.authorization).toMatch(/^bearer ey/);
    expect(Object.keys(call!.body!).sort()).toEqual(["aps", "botId", "kind", "pairing", "requestId", "roomId", "threadId", "v"]);
    expect(call!.body).toMatchObject({ v: 1, kind: "approval", botId: "bot_1", threadId: "th_1", pairing: "pair-0001", roomId: "grp_1", requestId: "req_1" });
    const aps = call!.body!.aps as Record<string, unknown>;
    expect(Object.keys(aps).sort()).toEqual(["alert", "category", "interruption-level", "sound", "thread-id"]);
    expect(aps).toMatchObject({ alert: { title: "Scout needs approval" }, sound: "default", "thread-id": "th_1", category: "OPENMAUS_APPROVAL", "interruption-level": "time-sensitive" });
    expect(call!.text).not.toContain("Hidden Bot Name");
    expect(call!.text).not.toContain("Launch plans");
    expect(call!.text).not.toContain("omb");
    expect(call!.text).not.toContain("seira");
    expect(call!.text).not.toContain("\"body\"");
  });

  it("AC-08: uses the production host for a production token and the sandbox host for a sandbox token", async () => {
    const h = harness();
    const { credential } = await h.install();
    await h.registerApns(credential, OTHER_APNS_TOKEN, "sandbox");
    expect((await h.send(credential, OTHER_APNS_TOKEN)).status).toBe(202);
    expect(h.providers.apns()[0]!.host).toBe("api.sandbox.push.apple.com");
  });

  it("AC-08: derives a collapse id of 32 hex characters when the request has none", async () => {
    const { h, credential } = await registered();
    await h.send(credential, APNS_TOKEN);
    const collapse = h.providers.apns()[0]!.headers["apns-collapse-id"]!;
    expect(collapse).toMatch(/^[0-9a-f]{32}$/);
    const request = { v: 1 as const, token: APNS_TOKEN, notification: { ...NOTIFICATION } };
    expect(await collapseIdOf(request)).toBe(collapse);
  });

  it("AC-08: keeps the category and the interruption level table of the shipped phone apps", async () => {
    expect([...KIND_PRESENTATION.keys()].sort()).toEqual(["approval", "mention", "question", "routine-blocked", "routine-deferred", "routine-failed", "sign-in"]);
    const { h, credential } = await registered();
    await h.send(credential, APNS_TOKEN, { kind: "question" });
    await h.send(credential, APNS_TOKEN, { kind: "done" });
    const [question, done] = h.providers.apns().map((call) => call.body!.aps as Record<string, unknown>);
    expect(question).toMatchObject({ category: "OPENMAUS_QUESTION", "interruption-level": "time-sensitive" });
    expect(done).toMatchObject({ category: "OPENMAUS_UPDATE", "interruption-level": "active" });
  });

  it("AC-10: puts requestId in the APNs payload, and leaves it out when the request has none", async () => {
    const { h, credential } = await registered();
    await h.send(credential, APNS_TOKEN, { requestId: "req_77" });
    await h.send(credential, APNS_TOKEN, { requestId: undefined, roomId: undefined });
    const [withRequest, without] = h.providers.apns();
    expect(withRequest!.body).toMatchObject({ requestId: "req_77" });
    expect(Object.keys(without!.body!).sort()).toEqual(["aps", "botId", "kind", "threadId", "v"]);
  });

  it("AC-17: answers 404 push_device_unknown for a token of another installation and sends nothing", async () => {
    const { h, credential } = await registered();
    const stranger = await h.install();
    const response = await h.send(stranger.credential, APNS_TOKEN);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "push_device_unknown" });
    expect((await h.send(credential, OTHER_APNS_TOKEN)).status).toBe(404);
    expect(h.providers.calls).toHaveLength(0);
  });

  it("AC-17: answers 404 push_device_unknown for a token that is registered for activity, not for alerts", async () => {
    const h = harness();
    const { credential } = await h.install();
    const register = await h.register(credential, { v: 1, token: APNS_TOKEN, environment: "production", purpose: "activity" });
    expect(register.status).toBe(200);
    expect((await h.send(credential, APNS_TOKEN)).status).toBe(404);
    expect(h.providers.calls).toHaveLength(0);
  });

  it("AC-19: deletes a dead token for every installation and answers 410 push_device_unregistered", async () => {
    const { h, credential } = await registered();
    const second = await h.install();
    await h.registerApns(second.credential);
    h.providers.queues.apns.push({ status: 410, body: { reason: "Unregistered" } });
    const response = await h.send(credential, APNS_TOKEN);
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "push_device_unregistered" });
    expect(h.devices()).toHaveLength(0);
  });

  it("AC-19: treats BadDeviceToken and DeviceTokenNotForTopic as dead tokens", async () => {
    for (const reason of ["BadDeviceToken", "DeviceTokenNotForTopic"]) {
      const { h, credential } = await registered();
      h.providers.queues.apns.push({ status: 400, body: { reason } });
      expect((await h.send(credential, APNS_TOKEN)).status, reason).toBe(410);
      expect(h.devices()).toHaveLength(0);
    }
  });

  it("AC-19: deletes a dead token only in the same APNs environment", async () => {
    const { h, credential } = await registered();
    const other = await h.install();
    await h.registerApns(other.credential, APNS_TOKEN, "sandbox");
    h.providers.queues.apns.push({ status: 410, body: { reason: "Unregistered" } });
    expect((await h.send(credential, APNS_TOKEN)).status).toBe(410);
    expect(h.devices()).toMatchObject([{ installation_id: other.installationId }]);
  });

  it("AC-19: keeps a token that was registered after the time that APNs gave", async () => {
    const { h, credential } = await registered();
    h.clock.advance(60);
    await h.registerApns(credential);
    h.providers.queues.apns.push({ status: 410, body: { reason: "Unregistered", timestamp: h.clock.ms - 30_000 } });
    expect((await h.send(credential, APNS_TOKEN)).status).toBe(410);
    expect(h.devices()).toHaveLength(1);
  });

  it("AC-22: answers 429 when an installation has taken 600 sends in the hour, and allows sends in the next hour", async () => {
    const { h, credential, installationId } = await registered();
    const window = Math.floor(h.clock.ms / HOUR_MS) * HOUR_MS;
    h.d1.db.prepare("INSERT INTO action_limits (subject, action, window_start, count) VALUES (?, 'send', ?, 600)").run(`inst:${installationId}`, window);
    const refused = await h.send(credential, APNS_TOKEN);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("3600");
    expect(h.providers.calls).toHaveLength(0);
    h.clock.advance(3600);
    expect((await h.send(credential, APNS_TOKEN)).status).toBe(202);
  });

  it("AC-22: answers 429 on the 61st send to one token in an hour", async () => {
    const { h, credential } = await registered();
    for (let n = 0; n < 60; n += 1) expect((await h.send(credential, APNS_TOKEN)).status).toBe(202);
    const refused = await h.send(credential, APNS_TOKEN);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "rate_limited" });
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(h.providers.apns()).toHaveLength(60);
  });

  it("AC-22: answers 429 when a token reaches the daily cap across all installations", async () => {
    const { h, credential } = await registered({ env: { TOKEN_DAILY: "2" } });
    const second = await h.install();
    await h.registerApns(second.credential);
    expect((await h.send(credential, APNS_TOKEN)).status).toBe(202);
    expect((await h.send(second.credential, APNS_TOKEN)).status).toBe(202);
    const refused = await h.send(credential, APNS_TOKEN);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe(String(14 * 3600));
    expect(h.providers.apns()).toHaveLength(2);
    h.clock.advance(15 * 3600);
    expect((await h.send(credential, APNS_TOKEN)).status).toBe(202);
  });

  it("AC-22: answers 429 when all sends reach the global hourly cap", async () => {
    const { h, credential } = await registered({ env: { SEND_GLOBAL_HOURLY: "2" } });
    expect((await h.send(credential, APNS_TOKEN)).status).toBe(202);
    expect((await h.send(credential, APNS_TOKEN)).status).toBe(202);
    expect((await h.send(credential, APNS_TOKEN)).status).toBe(429);
    expect(h.providers.apns()).toHaveLength(2);
  });

  it("AC-23: blocks an installation for 24 hours after 20 dead-token answers in one hour", async () => {
    const { h, credential, installationId } = await registered();
    for (let n = 0; n < 20; n += 1) {
      expect((await h.registerApns(credential)).status).toBe(200);
      h.providers.queues.apns.push({ status: 410, body: { reason: "Unregistered" } });
      expect((await h.send(credential, APNS_TOKEN)).status, `dead ${n}`).toBe(410);
    }
    const [row] = h.d1.rows<{ blocked_until: number }>("SELECT blocked_until FROM installations WHERE id = ?", installationId);
    expect(row!.blocked_until).toBe(h.clock.ms + 24 * HOUR_MS);
    await h.registerApns(credential);
    const calls = h.providers.apns().length;
    const refused = await h.send(credential, APNS_TOKEN);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe(String(24 * 3600));
    expect(h.providers.apns()).toHaveLength(calls);
    h.clock.advance(24 * 3600 + 1);
    expect((await h.send(credential, APNS_TOKEN)).status).toBe(202);
  });

  it("AC-23: does not block an installation with fewer than 20 dead-token answers", async () => {
    const { h, credential } = await registered();
    for (let n = 0; n < 19; n += 1) {
      await h.registerApns(credential);
      h.providers.queues.apns.push({ status: 410, body: { reason: "Unregistered" } });
      await h.send(credential, APNS_TOKEN);
    }
    await h.registerApns(credential);
    expect((await h.send(credential, APNS_TOKEN)).status).toBe(202);
  });

  it("answers 429 with retry-after when APNs throttles, 503 when APNs refuses the key twice, and 502 for another failure", async () => {
    const { h, credential } = await registered();
    h.providers.queues.apns.push({ status: 429, body: { reason: "TooManyRequests" } });
    const throttled = await h.send(credential, APNS_TOKEN);
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBe("60");
    h.providers.queues.apns.push({ status: 403, body: { reason: "InvalidProviderToken" } }, { status: 403, body: { reason: "InvalidProviderToken" } });
    const refused = await h.send(credential, APNS_TOKEN);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: "push_unavailable" });
    h.providers.queues.apns.push({ status: 500, body: { reason: "InternalServerError" } });
    const failed = await h.send(credential, APNS_TOKEN);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "push_failed" });
  });

  it("sends again with a new provider token when APNs refuses the first one", async () => {
    const { h, credential } = await registered();
    h.providers.queues.apns.push({ status: 403, body: { reason: "ExpiredProviderToken" } });
    expect((await h.send(credential, APNS_TOKEN)).status).toBe(202);
    expect(h.providers.apns()).toHaveLength(2);
  });

  it("answers 400 invalid_request for a send body of the wrong shape", async () => {
    const { h, credential } = await registered();
    for (const body of [{ v: 1, token: APNS_TOKEN }, { v: 1, token: APNS_TOKEN, notification: { kind: "Bad Kind", title: "t", botId: "b", botName: "B", threadId: "t" } }, "{"]) {
      const response = await h.call("POST", "/v1/installations/self/push/send", { credential, body });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
    expect(h.providers.calls).toHaveLength(0);
  });
});
