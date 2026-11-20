import { describe, expect, it } from "vitest";

import { FCM_PROJECT, FCM_DEVICE, harness, OTHER_FCM_DEVICE } from "./test-harness";

async function registered(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  const mine = await h.install();
  expect((await h.registerFcm(mine.credential)).status).toBe(200);
  return { h, ...mine };
}

describe("send to FCM", () => {
  it("AC-07: answers 503 push_unavailable for register, send, and activity when the relay holds no FCM secret", async () => {
    const h = harness({ fcm: false });
    const { credential } = await h.install();
    const register = await h.registerFcm(credential);
    expect(register.status).toBe(503);
    expect(await register.json()).toEqual({ error: "push_unavailable" });

    const { h: held, credential: heldCredential } = await registered();
    delete held.env.FCM_SERVICE_ACCOUNT;
    const send = await held.send(heldCredential, FCM_DEVICE);
    expect(send.status).toBe(503);
    expect(held.providers.calls).toHaveLength(0);
    expect((await held.call("POST", "/v1/installations/self/push/activity", { credential: heldCredential, body: {} })).status).toBe(503);
  });

  it("AC-05: stores an FCM token with the platform fcm", async () => {
    const { h, installationId } = await registered();
    expect(h.devices()).toMatchObject([{ installation_id: installationId, platform: "fcm", token: FCM_DEVICE }]);
  });

  it("AC-09: sends one data-only message with the exact data keys, all strings", async () => {
    const { h, credential } = await registered();
    const response = await h.send(credential, FCM_DEVICE, {}, { collapseId: "bot_1:req_1", pairing: "pair-0001" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ sent: true });
    const [call, ...rest] = h.providers.fcm();
    expect(rest).toHaveLength(0);
    expect(call!.url).toBe(`https://fcm.googleapis.com/v1/projects/${FCM_PROJECT}/messages:send`);
    expect(call!.headers.authorization).toMatch(/^Bearer ya29\.test-/);
    const message = (call!.body as { message: { token: string; data: Record<string, unknown>; android: unknown; notification?: unknown } }).message;
    expect(Object.keys(message).sort()).toEqual(["android", "data", "token"]);
    expect(message.token).toBe(FCM_DEVICE);
    expect(message.android).toEqual({ priority: "HIGH", ttl: "86400s" });
    expect(Object.keys(message.data).sort()).toEqual(["botId", "channelId", "kind", "pairing", "requestId", "roomId", "tag", "threadId", "title", "v"]);
    expect(Object.values(message.data).every((value) => typeof value === "string")).toBe(true);
    expect(message.data).toEqual({
      v: "1",
      kind: "approval",
      botId: "bot_1",
      threadId: "th_1",
      title: "Scout needs approval",
      tag: "bot_1:req_1",
      channelId: "approval_question",
      pairing: "pair-0001",
      roomId: "grp_1",
      requestId: "req_1",
    });
    expect(call!.text).not.toContain("Launch plans");
    expect(call!.text).not.toContain("Hidden Bot Name");
    expect(call!.text).not.toContain("botName");
  });

  it("AC-09: uses the channel of the kind", async () => {
    const { h, credential } = await registered();
    await h.send(credential, FCM_DEVICE, { kind: "routine-failed" });
    await h.send(credential, FCM_DEVICE, { kind: "done" });
    const channels = h.providers.fcm().map((call) => (call.body as { message: { data: { channelId: string } } }).message.data.channelId);
    expect(channels).toEqual(["routine_failed", "bot_messages"]);
  });

  it("AC-10: puts requestId in the FCM data, and leaves it out when the request has none", async () => {
    const { h, credential } = await registered();
    await h.send(credential, FCM_DEVICE, { requestId: "req_9" });
    await h.send(credential, FCM_DEVICE, { requestId: undefined });
    const [withRequest, without] = h.providers.fcm().map((call) => (call.body as { message: { data: Record<string, string> } }).message.data);
    expect(withRequest!.requestId).toBe("req_9");
    expect(without).not.toHaveProperty("requestId");
  });

  it("AC-17: answers 404 push_device_unknown for an FCM token of another installation", async () => {
    const { h } = await registered();
    const stranger = await h.install();
    expect((await h.send(stranger.credential, FCM_DEVICE)).status).toBe(404);
    expect(h.providers.calls).toHaveLength(0);
  });

  it("AC-19: deletes a token that FCM calls UNREGISTERED for every installation, and answers 410", async () => {
    const { h, credential } = await registered();
    const second = await h.install();
    await h.registerFcm(second.credential);
    await h.registerFcm(second.credential, OTHER_FCM_DEVICE);
    h.providers.queues.fcm.push({ status: 404, body: { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } } });
    const response = await h.send(credential, FCM_DEVICE);
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "push_device_unregistered" });
    expect(h.devices().map((device) => device.token)).toEqual([OTHER_FCM_DEVICE]);
  });

  it("AC-19: deletes a token of another Firebase project (SENDER_ID_MISMATCH)", async () => {
    const { h, credential } = await registered();
    h.providers.queues.fcm.push({ status: 403, body: { error: { status: "PERMISSION_DENIED", details: [{ errorCode: "SENDER_ID_MISMATCH" }] } } });
    expect((await h.send(credential, FCM_DEVICE)).status).toBe(410);
    expect(h.devices()).toHaveLength(0);
  });

  it("AC-22: counts the dead-token answers of FCM toward the block of an installation", async () => {
    const { h, credential, installationId } = await registered();
    for (let n = 0; n < 20; n += 1) {
      await h.registerFcm(credential);
      h.providers.queues.fcm.push({ status: 404, body: { error: { details: [{ errorCode: "UNREGISTERED" }] } } });
      expect((await h.send(credential, FCM_DEVICE)).status).toBe(410);
    }
    expect(h.d1.rows<{ blocked_until: number | null }>("SELECT blocked_until FROM installations WHERE id = ?", installationId)[0]!.blocked_until).not.toBeNull();
  });

  it("AC-10: asks Google for one access token and reuses it until five minutes before it ends", async () => {
    const { h, credential } = await registered();
    await h.send(credential, FCM_DEVICE);
    await h.send(credential, FCM_DEVICE);
    expect(h.providers.oauth()).toHaveLength(1);
    expect(h.providers.fcm()).toHaveLength(2);
    expect(h.providers.fcm()[0]!.headers.authorization).toBe(h.providers.fcm()[1]!.headers.authorization);
    h.clock.advance(56 * 60);
    await h.send(credential, FCM_DEVICE);
    expect(h.providers.oauth()).toHaveLength(2);
  });

  it("asks Google at its fixed token address, not the address in the service-account file", async () => {
    const { h, credential } = await registered();
    await h.send(credential, FCM_DEVICE);
    expect(h.providers.oauth()[0]!.url).toBe("https://oauth2.googleapis.com/token");
    expect(h.providers.calls.some((call) => call.host === "attacker.example")).toBe(false);
  });

  it("gets a new access token and sends again when FCM refuses the first one with 401", async () => {
    const { h, credential } = await registered();
    h.providers.queues.fcm.push({ status: 401, body: { error: { status: "UNAUTHENTICATED" } } });
    expect((await h.send(credential, FCM_DEVICE)).status).toBe(202);
    expect(h.providers.oauth()).toHaveLength(2);
    expect(h.providers.fcm()).toHaveLength(2);
  });

  it("answers 503 push_unavailable when Google refuses the service account, and calls FCM never", async () => {
    const { h, credential } = await registered();
    h.providers.queues.oauth.push({ status: 400, body: { error: "invalid_grant" } });
    const response = await h.send(credential, FCM_DEVICE);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "push_unavailable" });
    expect(h.providers.fcm()).toHaveLength(0);
  });

  it("answers 429 when FCM throttles and 502 for another failure", async () => {
    const { h, credential } = await registered();
    h.providers.queues.fcm.push({ status: 429, body: { error: { status: "RESOURCE_EXHAUSTED" } } });
    const throttled = await h.send(credential, FCM_DEVICE);
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBe("60");
    h.providers.queues.fcm.push({ status: 500, body: { error: { status: "INTERNAL" } } });
    expect((await h.send(credential, FCM_DEVICE)).status).toBe(502);
  });
});
