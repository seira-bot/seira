import type { LookupAddress } from "node:dns";
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { A2aEgressError, a2aRequest, checkTarget, type EgressOptions } from "./egress.ts";

type Handler = (headers: IncomingHttpHeaders, res: ServerResponse, body: string) => void;

let server: Server;
let port = 0;
let connections = 0;
let seen: { headers: IncomingHttpHeaders; method?: string; url?: string; body: string }[] = [];
let handler: Handler = (_headers, res) => { res.end("ok"); };

beforeEach(async () => {
  connections = 0;
  seen = [];
  handler = (_headers, res) => { res.end("ok"); };
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ headers: req.headers, method: req.method, url: req.url, body });
      handler(req.headers, res, body);
    });
  });
  server.on("connection", () => { connections += 1; });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const ok = (over: Partial<EgressOptions> = {}): EgressOptions => ({ method: "GET", timeoutMs: 2_000, maxBytes: 1_024, ...over });
const loopbackUrl = (path = "/") => new URL(`http://127.0.0.1:${port}${path}`);
const lookupOf = (...addresses: string[]) => vi.fn(async (): Promise<LookupAddress[]> => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));

async function failure(promise: Promise<unknown>): Promise<A2aEgressError> {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(A2aEgressError);
    return error as A2aEgressError;
  }
  throw new Error("the request did not fail");
}

describe("target check", () => {
  it("returns the first address when every address is public, without a connection", async () => {
    const lookup = lookupOf("8.8.8.8", "2001:4860:4860::8888");
    await expect(checkTarget(new URL("https://far.example/rpc"), { lookup })).resolves.toEqual({ address: "8.8.8.8", family: 4 });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["loopback", "127.0.0.1"],
    ["private 10", "10.1.2.3"],
    ["private 172", "172.16.0.9"],
    ["private 192", "192.168.1.1"],
    ["link-local", "169.254.1.1"],
    ["metadata", "169.254.169.254"],
    ["CGNAT", "100.64.0.1"],
    ["unspecified", "0.0.0.0"],
    ["IPv6 loopback", "::1"],
    ["IPv6 unique-local", "fd00::1"],
    ["IPv6 metadata", "fd00:ec2::254"],
    ["IPv6 link-local", "fe80::1"],
    ["IPv4-mapped IPv6", "::ffff:10.0.0.1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
  ])("refuses a host that resolves to a %s address", async (_name, address) => {
    const error = await failure(checkTarget(new URL("https://far.example/"), { lookup: lookupOf(address), allowLoopback: false }));
    expect(error).toMatchObject({ reason: "refused", sent: false });
  });

  it("refuses a host that resolves to a public and a private address", async () => {
    const error = await failure(checkTarget(new URL("https://far.example/"), { lookup: lookupOf("8.8.8.8", "10.0.0.1") }));
    expect(error.reason).toBe("refused");
  });

  it("refuses an address literal that is private, without a lookup", async () => {
    const lookup = lookupOf("8.8.8.8");
    for (const literal of ["https://10.0.0.5/", "https://[::1]/", "https://[fd00::1]/", "https://169.254.169.254/latest"]) {
      expect((await failure(checkTarget(new URL(literal), { lookup }))).reason).toBe("refused");
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refuses plain http, a credential in the URL, an unresolved host and an empty answer", async () => {
    const lookup = lookupOf("8.8.8.8");
    expect((await failure(checkTarget(new URL("http://far.example/"), { lookup }))).reason).toBe("refused");
    expect((await failure(checkTarget(new URL("ftp://far.example/"), { lookup }))).reason).toBe("refused");
    expect((await failure(checkTarget(new URL("https://user:pw@far.example/"), { lookup }))).reason).toBe("refused");
    expect((await failure(checkTarget(new URL("https://far.example/"), { lookup: async () => { throw new Error("ENOTFOUND"); } }))).reason).toBe("refused");
    expect((await failure(checkTarget(new URL("https://far.example/"), { lookup: async () => [] }))).reason).toBe("refused");
  });
});

describe("test switch", () => {
  it("allows loopback and plain http to loopback when set", async () => {
    await expect(checkTarget(new URL("http://127.0.0.1:1/"), { allowLoopback: true })).resolves.toMatchObject({ address: "127.0.0.1" });
    await expect(checkTarget(new URL("https://[::1]/"), { allowLoopback: true })).resolves.toMatchObject({ address: "::1" });
  });

  it("reads the environment variable only when the dependency is absent", async () => {
    const target = new URL("http://127.0.0.1:1/");
    expect((await failure(checkTarget(target))).reason).toBe("refused");
    vi.stubEnv("SEIRA_TEST_A2A_LOOPBACK", "1");
    await expect(checkTarget(target)).resolves.toBeTruthy();
    vi.stubEnv("SEIRA_TEST_A2A_LOOPBACK", "true");
    expect((await failure(checkTarget(target))).reason).toBe("refused");
    expect((await failure(checkTarget(target, { allowLoopback: false }))).reason).toBe("refused");
  });

  it("changes nothing else: private and non-loopback addresses stay refused, and plain http stays loopback only", async () => {
    const deps = { allowLoopback: true };
    expect((await failure(checkTarget(new URL("https://10.0.0.1/"), deps))).reason).toBe("refused");
    expect((await failure(checkTarget(new URL("https://far.example/"), { ...deps, lookup: lookupOf("192.168.0.2") }))).reason).toBe("refused");
    expect((await failure(checkTarget(new URL("https://far.example/"), { ...deps, lookup: lookupOf("127.0.0.1", "10.0.0.1") }))).reason).toBe("refused");
    expect((await failure(checkTarget(new URL("http://far.example/"), { ...deps, lookup: lookupOf("8.8.8.8") }))).reason).toBe("refused");
    expect((await failure(checkTarget(new URL("http://far.example/"), { ...deps, lookup: lookupOf("8.8.8.8", "127.0.0.1") }))).reason).toBe("refused");
  });
});

describe("refused before sending", () => {
  it("opens no connection and reports sent false", async () => {
    const error = await failure(a2aRequest(loopbackUrl(), ok(), { allowLoopback: false }));
    expect(error).toMatchObject({ reason: "refused", sent: false });
    const mixed = await failure(a2aRequest(new URL(`http://far.example:${port}/`), ok(), { allowLoopback: true, lookup: lookupOf("127.0.0.1", "10.0.0.1") }));
    expect(mixed).toMatchObject({ reason: "refused", sent: false });
    expect(connections).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it("reports sent false when the connection is refused", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const freePort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const error = await failure(a2aRequest(new URL(`http://127.0.0.1:${freePort}/`), ok(), { allowLoopback: true }));
    expect(error).toMatchObject({ reason: "network", sent: false });
  });

  it("refuses at once when the signal is already aborted", async () => {
    const error = await failure(a2aRequest(loopbackUrl(), ok({ signal: AbortSignal.abort() }), { allowLoopback: true }));
    expect(error).toMatchObject({ reason: "aborted", sent: false });
    expect(connections).toBe(0);
  });
});

describe("request", () => {
  it("returns the status and the text, and marks the request sent", async () => {
    handler = (_headers, res) => { res.statusCode = 404; res.end("gone"); };
    await expect(a2aRequest(loopbackUrl("/card"), ok(), { allowLoopback: true })).resolves.toEqual({ status: 404, body: "gone", sent: true });
    expect(seen[0]).toMatchObject({ method: "GET", url: "/card" });
  });

  it("posts a body with its length", async () => {
    const body = JSON.stringify({ text: "héllo" });
    handler = (_headers, res) => { res.end("{}"); };
    await a2aRequest(loopbackUrl("/rpc"), ok({ method: "POST", body, headers: { "Content-Type": "application/json" } }), { allowLoopback: true });
    expect(seen[0]).toMatchObject({ method: "POST", body });
    expect(seen[0]?.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
  });

  it("sends the caller headers, never a cookie, and keeps the host name", async () => {
    await a2aRequest(new URL(`http://far.example:${port}/`), ok({ headers: { Authorization: "Bearer t", Cookie: "sid=1", "Proxy-Authorization": "x", Host: "evil.example" } }), {
      allowLoopback: true, lookup: lookupOf("127.0.0.1"),
    });
    const headers = seen[0]!.headers;
    expect(headers.authorization).toBe("Bearer t");
    expect(headers.cookie).toBeUndefined();
    expect(headers["proxy-authorization"]).toBeUndefined();
    expect(headers.host).toBe(`far.example:${port}`);
  });

  it("looks the host up once and dials the checked address, even when a second lookup would differ", async () => {
    const answers = [["127.0.0.1"], ["10.0.0.1"], ["10.0.0.1"]];
    let calls = 0;
    const lookup = vi.fn(async (): Promise<LookupAddress[]> => (answers[calls++] ?? answers[2]!).map((address) => ({ address, family: 4 })));
    const result = await a2aRequest(new URL(`http://rebind.example:${port}/`), ok(), { allowLoopback: true, lookup });
    expect(result.status).toBe(200);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(connections).toBe(1);
    expect(seen[0]?.headers.host).toBe(`rebind.example:${port}`);
  });

  it("fails on a redirect and does not follow it", async () => {
    handler = (_headers, res) => { res.statusCode = 302; res.setHeader("Location", `http://127.0.0.1:${port}/elsewhere`); res.end(); };
    const error = await failure(a2aRequest(loopbackUrl("/start"), ok(), { allowLoopback: true }));
    expect(error).toMatchObject({ reason: "redirect", sent: true });
    expect(seen.map((entry) => entry.url)).toEqual(["/start"]);
  });

  it("stops reading at the limit and does not wait for the rest", async () => {
    let closedEarly = false;
    let written = 0;
    handler = (_headers, res) => {
      res.on("close", () => { closedEarly = true; });
      const timer = setInterval(() => { written += 512; res.write("a".repeat(512)); }, 5);
      res.on("close", () => clearInterval(timer));
    };
    const error = await failure(a2aRequest(loopbackUrl(), ok({ maxBytes: 2_048 }), { allowLoopback: true }));
    expect(error).toMatchObject({ reason: "too-large", sent: true });
    await vi.waitFor(() => expect(closedEarly).toBe(true));
    expect(written).toBeLessThan(100_000);
  });

  it("refuses an announced size over the limit before it reads", async () => {
    handler = (_headers, res) => { res.setHeader("Content-Length", "5000"); res.write("a"); };
    expect((await failure(a2aRequest(loopbackUrl(), ok({ maxBytes: 1_000 }), { allowLoopback: true }))).reason).toBe("too-large");
  });

  it("accepts a body of exactly the limit", async () => {
    handler = (_headers, res) => { res.end("b".repeat(1_024)); };
    expect((await a2aRequest(loopbackUrl(), ok(), { allowLoopback: true })).body).toHaveLength(1_024);
  });

  it("times out as one limit for the whole request, with sent true", async () => {
    handler = () => {};
    const started = Date.now();
    const error = await failure(a2aRequest(loopbackUrl(), ok({ timeoutMs: 150 }), { allowLoopback: true }));
    expect(error).toMatchObject({ reason: "timeout", sent: true });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("times out a slow answer that keeps sending", async () => {
    handler = (_headers, res) => {
      const timer = setInterval(() => res.write("a"), 20);
      res.on("close", () => clearInterval(timer));
    };
    expect((await failure(a2aRequest(loopbackUrl(), ok({ timeoutMs: 200 }), { allowLoopback: true }))).reason).toBe("timeout");
  });

  it("aborts on the caller signal after the connection opened", async () => {
    handler = () => {};
    const controller = new AbortController();
    const pending = failure(a2aRequest(loopbackUrl(), ok({ signal: controller.signal }), { allowLoopback: true }));
    await vi.waitFor(() => expect(connections).toBe(1));
    controller.abort();
    expect(await pending).toMatchObject({ reason: "aborted", sent: true });
  });

  it("does not put the far text or address in an error message", async () => {
    handler = (_headers, res) => { res.statusCode = 302; res.setHeader("Location", "http://10.9.9.9/secret"); res.end(); };
    const error = await failure(a2aRequest(loopbackUrl(), ok(), { allowLoopback: true }));
    expect(error.message).not.toMatch(/10\.9\.9\.9|127\.0\.0\.1|secret/u);
  });
});
