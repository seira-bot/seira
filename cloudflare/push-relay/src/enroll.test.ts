import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { harness, TEST_IP } from "./test-harness";

const DAY_MS = 24 * 60 * 60 * 1000;
const CREDENTIAL = /^seira_install_([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

describe("enroll", () => {
  it("AC-01: answers 201 with a credential in the seira_install format that lasts 90 days", async () => {
    const h = harness();
    const { response, installationId, credential, expiresAt } = await h.install();
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(installationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(credential).toMatch(CREDENTIAL);
    expect(expiresAt).toBe(h.clock.ms + 90 * DAY_MS);
    expect(h.d1.rows("SELECT * FROM installations")).toHaveLength(1);
  });

  it("AC-01: stores only the SHA-256 hash of the credential, and the credential text is in no table", async () => {
    const h = harness();
    const { credential } = await h.install();
    const [, lookup, secret] = /^seira_install_([^.]+)\.(.+)$/.exec(credential)!;
    const [row] = h.d1.rows<{ lookup_id: string; secret_hash: string; expires_at: number }>("SELECT * FROM installation_credentials");
    expect(row!.lookup_id).toBe(lookup);
    expect(row!.secret_hash).toBe(createHash("sha256").update(credential).digest("hex"));
    expect(h.everyTable()).not.toContain(credential);
    expect(h.everyTable()).not.toContain(secret!);
  });

  it("AC-01: gives each enroll its own installation and credential", async () => {
    const h = harness();
    const first = await h.install();
    const second = await h.install();
    expect(first.installationId).not.toBe(second.installationId);
    expect(first.credential).not.toBe(second.credential);
  });

  it("AC-01: refuses a body that is not exactly {v:1}", async () => {
    const h = harness();
    for (const body of [{ v: 2 }, { v: 1, name: "x" }, {}, "not json", "[]"]) {
      const response = await h.call("POST", "/v1/push/enroll", { body });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
    expect((await h.call("POST", "/v1/push/enroll")).status).toBe(400);
    expect(h.d1.rows("SELECT * FROM installations")).toHaveLength(0);
  });

  it("AC-21: refuses the sixth enroll of one IP address in a UTC day, with retry-after to the next day", async () => {
    const h = harness();
    for (let n = 0; n < 5; n += 1) expect((await h.install(TEST_IP)).response.status).toBe(201);
    const refused = await h.install(TEST_IP);
    expect(refused.response.status).toBe(429);
    expect(await refused.response.json()).toEqual({ error: "rate_limited" });
    expect(refused.response.headers.get("retry-after")).toBe(String(14 * 3600));
    expect((await h.install("192.0.2.2")).response.status).toBe(201);
    h.clock.advance(15 * 3600);
    expect((await h.install(TEST_IP)).response.status).toBe(201);
  });

  it("AC-21: refuses an enroll when all enrolls of the day reach the global cap", async () => {
    const h = harness({ env: { ENROLL_GLOBAL_DAILY: "3" } });
    for (let n = 1; n <= 3; n += 1) expect((await h.install(`192.0.2.${n}`)).response.status).toBe(201);
    const refused = await h.install("192.0.2.9");
    expect(refused.response.status).toBe(429);
    expect(Number(refused.response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(h.d1.rows("SELECT * FROM installations")).toHaveLength(3);
  });

  it("AC-21: gives two IPv6 addresses of one /64 the same limit", async () => {
    const h = harness({ env: { ENROLL_PER_IP_DAILY: "2" } });
    expect((await h.install("2001:db8:1:2::1")).response.status).toBe(201);
    expect((await h.install("2001:db8:1:2:ffff:aaaa:bbbb:cccc")).response.status).toBe(201);
    const refused = await h.install("2001:db8:1:2::99");
    expect(refused.response.status).toBe(429);
    expect(refused.response.headers.get("retry-after")).toBeTruthy();
    expect((await h.install("2001:db8:1:3::1")).response.status).toBe(201);
  });

  it("AC-21: counts a request without cf-connecting-ip under one shared key", async () => {
    const h = harness({ env: { ENROLL_PER_IP_DAILY: "1" } });
    const first = await h.call("POST", "/v1/push/enroll", { body: { v: 1 }, ip: null });
    expect(first.status).toBe(201);
    expect((await h.call("POST", "/v1/push/enroll", { body: { v: 1 }, ip: null })).status).toBe(429);
  });

  it("AC-21: answers 429 with retry-after 60 when the enroll limiter refuses", async () => {
    const h = harness();
    h.limits.enroll = false;
    const response = await h.call("POST", "/v1/push/enroll", { body: { v: 1 } });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
  });

  it("AC-21: does not spend the daily limit on a refused body", async () => {
    const h = harness({ env: { ENROLL_PER_IP_DAILY: "1" } });
    expect((await h.call("POST", "/v1/push/enroll", { body: { v: 9 } })).status).toBe(400);
    expect((await h.install(TEST_IP)).response.status).toBe(201);
  });

  it("answers 503 enroll_unavailable when IP_HASH_KEY is missing", async () => {
    const h = harness({ env: { IP_HASH_KEY: undefined } });
    const response = await h.call("POST", "/v1/push/enroll", { body: { v: 1 } });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "enroll_unavailable" });
    expect(h.d1.rows("SELECT * FROM installations")).toHaveLength(0);
  });

  it("AC-27: keeps no IP address in any table", async () => {
    const h = harness();
    await h.install("203.0.113.99");
    await h.install("2001:db8:77:88::5");
    const text = h.everyTable();
    expect(text).not.toContain("203.0.113.99");
    expect(text).not.toContain("2001:db8");
    expect(text).not.toContain("77:88");
    const subjects = h.d1.rows<{ subject: string }>("SELECT subject FROM action_limits").map((row) => row.subject);
    expect(subjects).toContain("global");
    expect(subjects.filter((subject) => subject.startsWith("ip:")).every((subject) => /^ip:[0-9a-f]{64}$/.test(subject))).toBe(true);
  });
});
