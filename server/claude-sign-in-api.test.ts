// The Claude web sign-in as a cloud runner's own page drives it: HTTPS through a proxy, the owner's
// cookie session, the real routes and the real login controller, with only the Claude CLI faked.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-seira.ts";

let fixture: VerificationServer;
let pageOrigin: string;
let ownerCookie: string;
let clientToken: string;
const proxy = { "x-forwarded-for": "198.51.100.18", "x-forwarded-proto": "https" };

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${fixture.info.url}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.json() as any, headers: response.headers };
}
const page = (method: string, path: string, body?: unknown) =>
  call(method, path, body, { ...proxy, origin: pageOrigin, cookie: ownerCookie });
const claude = async () => (await page("GET", "/api/instances")).body.instances.find((row: any) => row.instanceId === "claude");

beforeAll(async () => {
  fixture = await launchVerificationServer({ FAKE_CLAUDE_AUTH: "file" });
  pageOrigin = `https://${new URL(fixture.info.url).host}`;
  const owner = await call("POST", "/api/auth/pairing", { scopes: ["admin", "client"] });
  const paired = await call("POST", "/api/auth/pair", { code: owner.body.code, label: "Runner page", cookie: true }, proxy);
  expect(paired.status).toBe(200);
  ownerCookie = paired.headers.get("set-cookie")!.split(";")[0]!;
  const phone = await call("POST", "/api/auth/pairing", { scopes: ["client"] });
  clientToken = (await call("POST", "/api/auth/pair", { code: phone.body.code, label: "Client only" }, proxy)).body.token;
}, 60_000);

afterAll(async () => { await fixture?.close(); });

describe("Claude web sign-in through a proxied runner page", () => {
  it("lists Claude as a signed-out engine that signs in by pasting a code", async () => {
    expect(await claude()).toMatchObject({ driverKind: "claudeAgent", snapshot: { authenticated: false }, authentication: { method: "paste-code" } });
  });

  it("refuses a stranger and a client-only session before any Claude process starts", async () => {
    expect((await call("POST", "/api/instances/claude/auth/start", {}, { ...proxy, origin: pageOrigin })).status).toBeGreaterThanOrEqual(401);
    expect((await call("POST", "/api/instances/claude/auth/start", {}, { ...proxy, authorization: `Bearer ${clientToken}` })).status).toBe(403);
    expect((await claude()).snapshot.authenticated).toBe(false);
  });

  it("shows Anthropic's link, ends the flow on a refused code, and signs in on a fresh start with a good one", async () => {
    const first = await page("POST", "/api/instances/claude/auth/start", {});
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.body.auth).toMatchObject({ phase: "waiting", flowId: expect.any(String) });
    expect(new URL(first.body.auth.authorizationUrl).hostname).toBe("claude.ai");
    expect(first.body.auth).not.toHaveProperty("userCode");

    const refused = await page("POST", "/api/instances/claude/auth/complete", { flowId: first.body.auth.flowId, code: "bad-12345678" });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body.error).toMatch(/code|sign-in/i);
    expect((await page("GET", `/api/instances/claude/auth/status?flowId=${first.body.auth.flowId}`)).body.auth.phase).toBe("failed");
    expect((await claude()).snapshot.authenticated).toBe(false);

    const second = await page("POST", "/api/instances/claude/auth/start", {});
    expect(second.body.auth.flowId).not.toBe(first.body.auth.flowId);
    const done = await page("POST", "/api/instances/claude/auth/complete", { flowId: second.body.auth.flowId, code: "alice-12345678#state" });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toEqual({ ok: true });
    // The page treats the 200 as the sign-in and reads no status after it: the finished flow is gone.
    expect((await page("GET", `/api/instances/claude/auth/status?flowId=${second.body.auth.flowId}`)).status).toBe(404);
    expect((await claude()).snapshot).toMatchObject({ state: "available", authenticated: true, account: { email: "alice@example.com" } });
  });

  it("answers a start on a signed-in engine with success at once, without opening a second login", async () => {
    const again = await page("POST", "/api/instances/claude/auth/start", {});
    expect(again.body.auth).toMatchObject({ phase: "succeeded" });
  });

  it("cancels a waiting sign-in and leaves the engine signed out after sign-out", async () => {
    expect((await page("POST", "/api/instances/claude/auth/sign-out", {})).status).toBe(200);
    expect((await claude()).snapshot.authenticated).toBe(false);
    const started = await page("POST", "/api/instances/claude/auth/start", {});
    const cancelled = await page("POST", "/api/instances/claude/auth/cancel", { flowId: started.body.auth.flowId });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect((await page("GET", `/api/instances/claude/auth/status?flowId=${started.body.auth.flowId}`)).body.auth.phase).toBe("cancelled");
    expect((await claude()).snapshot.authenticated).toBe(false);
  });
});
