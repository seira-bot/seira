import { describe, expect, it } from "vitest";

import { APNS_TOKEN, harness } from "./test-harness";

const DAY = 24 * 60 * 60;
const body = { v: 1, token: APNS_TOKEN, environment: "production" };
const sendBody = { v: 1, token: APNS_TOKEN, notification: { kind: "approval", title: "T", botId: "b", botName: "B", threadId: "t" } };

const ROUTES: Array<[string, string, unknown]> = [
  ["POST", "/v1/installations/self/push/register", body],
  ["POST", "/v1/installations/self/push/unregister", { v: 1, token: APNS_TOKEN }],
  ["POST", "/v1/installations/self/push/send", sendBody],
  ["POST", "/v1/installations/self/push/activity", {}],
  ["POST", "/v1/installations/self/credentials/rotate", undefined],
  ["DELETE", "/v1/installations/self", undefined],
];

describe("credentials", () => {
  it("AC-13: answers 401 on every Bearer route with no credential", async () => {
    const h = harness();
    for (const [method, path, requestBody] of ROUTES) {
      const response = await h.call(method, path, { body: requestBody });
      expect(response.status, path).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    expect(h.providers.calls).toHaveLength(0);
  });

  it("AC-13: answers 401 and calls no provider for a bad credential", async () => {
    const h = harness();
    const good = await h.install();
    expect((await h.registerApns(good.credential)).status).toBe(200);
    const [, lookup, secret] = /^seira_install_([^.]+)\.(.+)$/.exec(good.credential)!;
    const flipped = `${secret!.slice(0, -1)}${secret!.endsWith("A") ? "B" : "A"}`;
    const cases: Record<string, string | undefined> = {
      malformed: "not-a-credential",
      "wrong prefix": `omb_install_${lookup}.${secret}`,
      "too short": `seira_install_${lookup}.short`,
      unknown: `seira_install_${"A".repeat(22)}.${"B".repeat(43)}`,
      "wrong secret": `seira_install_${lookup}.${flipped}`,
    };
    for (const [name, credential] of Object.entries(cases)) {
      const response = await h.send(credential!, APNS_TOKEN);
      expect(response.status, name).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    const wrongScheme = await h.call("POST", "/v1/installations/self/push/send", { body: sendBody, headers: { authorization: `Basic ${good.credential}` } });
    expect(wrongScheme.status).toBe(401);
    expect(h.providers.calls).toHaveLength(0);
  });

  it("AC-13: answers 401 for an expired credential", async () => {
    const h = harness();
    const { credential } = await h.install();
    expect((await h.registerApns(credential)).status).toBe(200);
    h.clock.advance(89 * DAY);
    expect((await h.send(credential, APNS_TOKEN)).status).toBe(202);
    h.clock.advance(2 * DAY);
    expect((await h.send(credential, APNS_TOKEN)).status).toBe(401);
    expect(h.providers.apns()).toHaveLength(1);
  });

  it("AC-13: answers 401 for a revoked credential", async () => {
    const h = harness();
    const { credential, installationId } = await h.install();
    expect((await h.registerApns(credential)).status).toBe(200);
    h.d1.db.prepare("UPDATE installation_credentials SET revoked_at = ? WHERE installation_id = ?").run(h.clock.ms, installationId);
    expect((await h.send(credential, APNS_TOKEN)).status).toBe(401);
    expect(h.providers.calls).toHaveLength(0);
  });

  it("AC-13: answers 401 for the credential of a deleted installation", async () => {
    const h = harness();
    const { credential } = await h.install();
    expect((await h.registerApns(credential)).status).toBe(200);
    h.d1.db.exec("DELETE FROM installations");
    expect((await h.send(credential, APNS_TOKEN)).status).toBe(401);
    expect(h.providers.calls).toHaveLength(0);
  });

  it("AC-15: rotate gives a new credential, and the old one answers 401", async () => {
    const h = harness();
    const { credential: oldCredential, installationId } = await h.install();
    h.clock.advance(61 * DAY);
    const rotated = await h.call("POST", "/v1/installations/self/credentials/rotate", { credential: oldCredential });
    expect(rotated.status).toBe(200);
    const answer = (await rotated.json()) as { credential: string; expiresAt: number };
    expect(answer.credential).toMatch(/^seira_install_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(answer.credential).not.toBe(oldCredential);
    expect(answer.expiresAt).toBe(h.clock.ms + 90 * DAY * 1000);
    expect((await h.registerApns(oldCredential)).status).toBe(401);
    expect((await h.registerApns(answer.credential)).status).toBe(200);
    expect(h.d1.rows("SELECT * FROM installations")).toHaveLength(1);
    expect(h.d1.rows("SELECT * FROM installation_credentials WHERE installation_id = ? AND revoked_at IS NULL", installationId)).toHaveLength(1);
    expect(h.everyTable()).not.toContain(answer.credential);
  });

  it("AC-15: keeps the registered tokens after a rotate", async () => {
    const h = harness();
    const { credential } = await h.install();
    await h.registerApns(credential);
    const rotated = (await (await h.call("POST", "/v1/installations/self/credentials/rotate", { credential })).json()) as { credential: string };
    expect((await h.send(rotated.credential, APNS_TOKEN)).status).toBe(202);
  });

  it("deletes the installation, its credentials, and its tokens on DELETE self, and keeps other installations", async () => {
    const h = harness();
    const mine = await h.install();
    const other = await h.install();
    await h.registerApns(mine.credential);
    await h.registerApns(other.credential, APNS_TOKEN);
    const response = await h.call("DELETE", "/v1/installations/self", { credential: mine.credential });
    expect(response.status).toBe(204);
    expect(h.d1.rows("SELECT id FROM installations")).toEqual([{ id: other.installationId }]);
    expect(h.d1.rows("SELECT * FROM installation_credentials")).toHaveLength(1);
    expect(h.devices().map((device) => device.installation_id)).toEqual([other.installationId]);
    expect((await h.registerApns(mine.credential)).status).toBe(401);
  });

  it("writes last_seen_at at most once an hour", async () => {
    const h = harness();
    const { credential, installationId } = await h.install();
    const seen = () => h.d1.rows<{ last_seen_at: number }>("SELECT last_seen_at FROM installations WHERE id = ?", installationId)[0]!.last_seen_at;
    const first = seen();
    h.clock.advance(10 * 60);
    await h.registerApns(credential);
    expect(seen()).toBe(first);
    h.clock.advance(51 * 60);
    await h.registerApns(credential);
    expect(seen()).toBe(h.clock.ms);
  });
});
