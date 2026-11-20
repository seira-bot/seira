import { describe, expect, it } from "vitest";

import { APNS_TOKEN, harness } from "./test-harness";

describe("kill switches", () => {
  it("AC-24: answers 503 push_unavailable for register, send, and activity while PUSH_PAUSED is true, before any D1 read", async () => {
    const h = harness();
    const { credential } = await h.install();
    expect((await h.registerApns(credential)).status).toBe(200);
    h.env.PUSH_PAUSED = "true";
    const queries = h.d1.sqlLog.length;
    const answers = [
      await h.registerApns(credential),
      await h.send(credential, APNS_TOKEN),
      await h.call("POST", "/v1/installations/self/push/activity", { credential, body: {} }),
      await h.call("POST", "/v1/installations/self/push/send", { body: {} }),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(503);
      expect(await answer.json()).toEqual({ error: "push_unavailable" });
    }
    expect(h.d1.sqlLog).toHaveLength(queries);
    expect(h.providers.calls).toHaveLength(0);
  });

  it("AC-24: still lets enroll, rotate, unregister, delete, and healthz work while PUSH_PAUSED is true", async () => {
    const h = harness();
    const { credential } = await h.install();
    h.env.PUSH_PAUSED = "true";
    expect((await h.install()).response.status).toBe(201);
    expect((await h.call("GET", "/healthz")).status).toBe(200);
    expect((await h.unregister(credential, { v: 1, token: APNS_TOKEN })).status).toBe(204);
    const rotated = await h.call("POST", "/v1/installations/self/credentials/rotate", { credential });
    expect(rotated.status).toBe(200);
    const { credential: next } = (await rotated.json()) as { credential: string };
    expect((await h.call("DELETE", "/v1/installations/self", { credential: next })).status).toBe(204);
  });

  it("AC-24: answers 503 enroll_unavailable while ENROLL_PAUSED is true, and keeps push working", async () => {
    const h = harness();
    const { credential } = await h.install();
    expect((await h.registerApns(credential)).status).toBe(200);
    h.env.ENROLL_PAUSED = "true";
    const before = h.d1.rows("SELECT * FROM installations").length;
    const response = await h.call("POST", "/v1/push/enroll", { body: { v: 1 } });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "enroll_unavailable" });
    expect(h.d1.rows("SELECT * FROM installations")).toHaveLength(before);
    expect((await h.send(credential, APNS_TOKEN)).status).toBe(202);
  });
});
