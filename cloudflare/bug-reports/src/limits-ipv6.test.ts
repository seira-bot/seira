import { describe, expect, it } from "vitest";

import { ipHashOf } from "./common";
import { bugHarness, pkcs8Pem, validReport } from "./test-harness";

const ipOf = (ip: string) => ({ "cf-connecting-ip": ip });
const from = (h: ReturnType<typeof bugHarness>, n: number, ip: string) =>
  h.send(validReport({ installId: `install-id-for-v6-test-${n}`, description: `The Bash tool failed, v6 case ${n}.` }), ipOf(ip));

const SAME_PREFIX = ["2001:db8:aaaa:bbbb::1", "2001:db8:aaaa:bbbb:ffff:1:2:3", "2001:DB8:AAAA:BBBB:0:0:0:9", "2001:db8:aaaa:bbbb::dead:beef"];

describe("AC-10 limiter keys", () => {
  it("gives the report limiter the /64 prefix of an IPv6 address", async () => {
    const h = bugHarness();
    expect((await from(h, 1, "2001:db8:aaaa:bbbb:1:2:3:4")).status).toBe(201);
    expect(h.limits.keys).toEqual(["2001:db8:aaaa:bbbb::/64"]);
  });

  it("gives the status limiter the /64 prefix of an IPv6 address", async () => {
    const h = bugHarness();
    const response = await h.status({ installId: "install-id-for-tests-0001", ids: [] }, ipOf("2001:db8:aaaa:bbbb:1:2:3:4"));
    expect(response.status).toBe(200);
    expect(h.limits.statusKeys).toEqual(["2001:db8:aaaa:bbbb::/64"]);
  });

  it("keeps the full IPv4 address for the limiters", async () => {
    const h = bugHarness();
    await from(h, 1, "198.51.100.20");
    await h.status({ installId: "install-id-for-tests-0001", ids: [] }, ipOf("198.51.100.21"));
    expect(h.limits.keys).toEqual(["198.51.100.20"]);
    expect(h.limits.statusKeys).toEqual(["198.51.100.21"]);
  });

  it("gives an IPv4-mapped IPv6 address the key of the IPv4 address", async () => {
    const h = bugHarness();
    await from(h, 1, "::ffff:198.51.100.20");
    expect(h.limits.keys).toEqual(["198.51.100.20"]);
  });
});

describe("AC-10 stored IP hash", () => {
  it("stores the same IP hash for every address of a /64 and another for the next /64", async () => {
    const h = bugHarness();
    for (const [n, ip] of SAME_PREFIX.slice(0, 2).entries()) expect((await from(h, n, ip)).status).toBe(201);
    expect((await from(h, 9, "2001:db8:aaaa:bbbc::1")).status).toBe(201);
    const hashes = h.d1.rows<{ ip_hash: string }>("SELECT ip_hash FROM reports ORDER BY rowid").map((row) => row.ip_hash);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[2]).not.toBe(hashes[0]);
  });

  it("keeps no IPv6 address or prefix in any D1 table", async () => {
    const h = bugHarness();
    await from(h, 1, "2001:db8:aaaa:bbbb:1:2:3:4");
    const dump = h.everyTable();
    expect(dump).not.toContain("2001:db8");
    expect(dump).not.toContain("aaaa:bbbb");
  });

  it("AC-13 stores for an IPv4 address the same hash as before the /64 change", async () => {
    const h = bugHarness();
    await from(h, 1, "198.51.100.20");
    const row = h.d1.rows<{ ip_hash: string }>("SELECT ip_hash FROM reports")[0]!;
    expect(row.ip_hash).toBe(await ipHashOf(pkcs8Pem, "198.51.100.20"));
  });
});

describe("AC-11 one hourly limit for a /64", () => {
  it("refuses the 11th report from one /64 whatever the address or the install ID, and does not call GitHub", async () => {
    const h = bugHarness();
    for (let n = 1; n <= 10; n += 1) expect((await from(h, n, SAME_PREFIX[n % SAME_PREFIX.length]!)).status).toBe(201);
    const calls = h.github.requests.length;
    const response = await from(h, 11, "2001:db8:aaaa:bbbb:7:7:7:7");
    expect(response.status).toBe(429);
    const body = (await response.json()) as { retryAfter: number };
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(body.retryAfter).toBe(Number(response.headers.get("retry-after")));
    expect(h.github.requests).toHaveLength(calls);
  });

  it("lets the /64 send again after the hour", async () => {
    const h = bugHarness();
    for (let n = 1; n <= 10; n += 1) expect((await from(h, n, SAME_PREFIX[n % SAME_PREFIX.length]!)).status).toBe(201);
    expect((await from(h, 11, SAME_PREFIX[0]!)).status).toBe(429);
    h.clock.advance(3601);
    expect((await from(h, 12, SAME_PREFIX[0]!)).status).toBe(201);
  });
});

describe("AC-12 separate limits for separate /64 prefixes", () => {
  it("serves another /64 and an IPv4 address when one /64 is full", async () => {
    const h = bugHarness();
    for (let n = 1; n <= 10; n += 1) expect((await from(h, n, SAME_PREFIX[0]!)).status).toBe(201);
    expect((await from(h, 11, SAME_PREFIX[1]!)).status).toBe(429);
    expect((await from(h, 12, "2001:db8:aaaa:bbbc::1")).status).toBe(201);
    expect((await from(h, 13, "198.51.100.20")).status).toBe(201);
  });

  it("keeps IPv4 addresses in separate limits", async () => {
    const h = bugHarness();
    for (let n = 1; n <= 10; n += 1) expect((await from(h, n, "198.51.100.20")).status).toBe(201);
    expect((await from(h, 11, "198.51.100.20")).status).toBe(429);
    expect((await from(h, 12, "198.51.100.21")).status).toBe(201);
  });
});

describe("AC-15 a header that is not an address", () => {
  it("uses unknown for a missing or empty header", async () => {
    const h = bugHarness();
    expect((await from(h, 1, "")).status).toBe(201);
    expect(h.limits.keys).toEqual(["unknown"]);
  });

  it("uses the text of a header that is not an address, and files the report", async () => {
    const h = bugHarness();
    expect((await from(h, 1, "not-an-ip")).status).toBe(201);
    expect(h.limits.keys).toEqual(["not-an-ip"]);
  });
});
