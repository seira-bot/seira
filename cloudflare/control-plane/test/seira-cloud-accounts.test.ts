import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { readConfig } from "../src/config";
import { createWorker } from "../src/index";
import { cloudAccountId, cloudToken, FakeSeiraCloud, seiraCloudEnv } from "./seira-cloud-stub";

const BASE_URL = "https://accounts.seira.test";
const worker = createWorker();

interface CallOptions {
  body?: unknown;
  env?: Env;
  method?: string;
  token?: string;
}

async function call(path: string, options: CallOptions = {}) {
  const headers = new Headers();
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers.set("content-type", "application/json");
  }
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${BASE_URL}${path}`, { body, headers, method: options.method ?? "GET" }),
    options.env ?? env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

const TOKEN = cloudToken("A");
const ACCOUNT = cloudAccountId(1);
const EMAIL = "owner@example.test";

function signedIn() {
  const stub = new FakeSeiraCloud();
  stub.add(TOKEN, ACCOUNT, EMAIL);
  return { stub, cloudEnv: seiraCloudEnv(stub) };
}

const SERVER_BODY = { name: "Home server", clientInstanceId: "server-1", platform: "linux", kind: "server" };

async function count(sql: string): Promise<number> {
  return (await env.DB.prepare(sql).first<{ n: number }>())?.n ?? -1;
}

describe("Seira Cloud account mode", () => {
  it("answers 404 on every /api/auth path and needs no Better Auth setting", async () => {
    const { stub, cloudEnv } = signedIn();
    for (const [method, path] of [
      ["POST", "/api/auth/sign-in/email-otp"],
      ["POST", "/api/auth/email-otp/send-verification-otp"],
      ["GET", "/api/auth/get-session"],
      ["GET", "/api/auth/anything/else"],
    ] as const) {
      const response = await call(path, { env: cloudEnv, method, body: method === "POST" ? {} : undefined });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
    expect(stub.requests).toHaveLength(0);
    expect(cloudEnv).not.toHaveProperty("BETTER_AUTH_SECRET");
  });

  it("reports the account service in /healthz in both modes", async () => {
    const { cloudEnv } = signedIn();
    const cloud = await call("/healthz", { env: cloudEnv });
    expect(cloud.status).toBe(200);
    expect(await cloud.json()).toMatchObject({ ok: true, service: "seira-control-plane", accounts: "seira-cloud" });
    const betterAuth = await call("/healthz");
    expect(betterAuth.status).toBe(200);
    expect(await betterAuth.json()).toMatchObject({ ok: true, accounts: "better-auth" });
  });

  it("refuses to start with an unknown mode or without the Seira Cloud binding", async () => {
    const { cloudEnv } = signedIn();
    const unknown = { ...cloudEnv, ACCOUNT_SERVICE: "ldap" } as unknown as Env;
    const unbound = { ...cloudEnv, SEIRA_CLOUD: undefined } as unknown as Env;
    expect(() => readConfig(unknown)).toThrow("ACCOUNT_SERVICE");
    expect(() => readConfig(unbound)).toThrow("SEIRA_CLOUD");
    for (const bad of [unknown, unbound]) {
      const response = await call("/healthz", { env: bad });
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('{"error":"misconfigured"}');
    }
    expect(readConfig(cloudEnv).accountService).toBe("seira-cloud");
    expect(readConfig(env).accountService).toBe("better-auth");
  });

  it("reads the per-account endpoint limit with a default of 3 and bounds 1 to 100", () => {
    const { cloudEnv } = signedIn();
    const withLimit = (value: unknown) => ({ ...cloudEnv, SEIRA_ENDPOINTS_PER_ACCOUNT: value }) as unknown as Env;
    expect(readConfig(withLimit(undefined)).endpointsPerAccount).toBe(3);
    expect(readConfig(withLimit("")).endpointsPerAccount).toBe(3);
    expect(readConfig(withLimit("1")).endpointsPerAccount).toBe(1);
    expect(readConfig(withLimit("100")).endpointsPerAccount).toBe(100);
    for (const bad of ["0", "101", "many"]) expect(readConfig(withLimit(bad)).endpointsPerAccount).toBe(3);
  });

  it("registers a server only for a valid Seira Cloud session, and a bad session leaves no row", async () => {
    const { stub, cloudEnv } = signedIn();
    const register = (token?: string) => call("/v1/installations", {
      body: SERVER_BODY,
      env: cloudEnv,
      method: "POST",
      token,
    });

    expect((await register()).status).toBe(401);
    expect(stub.requests).toHaveLength(0);

    for (const malformed of ["omc_short", `omc_${"A".repeat(44)}`, `xmc_${"A".repeat(43)}`, "seira_install_x.y"]) {
      expect((await register(malformed)).status).toBe(401);
    }
    expect(stub.requests).toHaveLength(0);

    expect((await register(cloudToken("B"))).status).toBe(401);
    expect(stub.requests).toHaveLength(1);

    stub.override = "unauthorized";
    expect((await register(TOKEN)).status).toBe(401);

    for (const failure of ["server_error", "bad_body", "network_error"] as const) {
      stub.override = failure;
      const response = await register(TOKEN);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "account_service_unavailable" });
    }
    expect(await count("SELECT COUNT(*) AS n FROM installations")).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM "user"')).toBe(0);
  });

  it("sends Seira Cloud the token alone, and nothing that would change the device's app version", async () => {
    const { stub, cloudEnv } = signedIn();
    expect((await call("/v1/me", { env: cloudEnv, token: TOKEN })).status).toBe(200);
    const [request] = stub.requests;
    expect(request?.method).toBe("GET");
    expect(request?.url).toBe("https://cloud.seira.bot/api/cloud/desktop/session");
    expect([...(request?.headers.keys() ?? [])].sort()).toEqual(["accept", "authorization"]);
    expect(request?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("owns installations by the Seira Cloud account ID and never returns the token", async () => {
    const { stub, cloudEnv } = signedIn();
    const responses: string[] = [];

    const created = await call("/v1/installations", { body: SERVER_BODY, env: cloudEnv, method: "POST", token: TOKEN });
    expect(created.status).toBe(201);
    const createdText = await created.text();
    responses.push(createdText);
    const { credential } = JSON.parse(createdText) as { credential: string };
    expect(credential.startsWith("seira_install_")).toBe(true);

    const owned = await env.DB.prepare("SELECT owner_user_id, kind FROM installations").all<{ owner_user_id: string; kind: string }>();
    expect(owned.results).toEqual([{ owner_user_id: ACCOUNT, kind: "server" }]);
    const shadow = await env.DB.prepare('SELECT id, name, email, emailVerified FROM "user"').all();
    expect(shadow.results).toEqual([{
      id: ACCOUNT,
      name: "",
      email: `${ACCOUNT}@seira-cloud.invalid`,
      emailVerified: 1,
    }]);

    const list = await call("/v1/installations", { env: cloudEnv, token: TOKEN });
    expect(list.status).toBe(200);
    const listText = await list.text();
    responses.push(listText);
    expect(JSON.parse(listText)).toMatchObject({ installations: [{ clientInstanceId: "server-1" }] });

    const me = await call("/v1/me", { env: cloudEnv, token: TOKEN });
    expect(me.status).toBe(200);
    const meText = await me.text();
    responses.push(meText);
    expect(JSON.parse(meText)).toEqual({ user: { id: ACCOUNT, email: EMAIL, name: "", emailVerified: true } });

    const endpoint = await call("/v1/installations/self/endpoint", { env: cloudEnv, token: credential });
    expect(endpoint.status).toBe(200);
    responses.push(await endpoint.text());

    for (const text of responses) expect(text).not.toContain(TOKEN);
    expect(await count(`SELECT COUNT(*) AS n FROM "user" WHERE email = '${EMAIL}'`)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM "user"')).toBe(1);
    expect(stub.requests.length).toBeGreaterThan(0);
  });

  it("never lets an installation credential act as an account", async () => {
    const { stub, cloudEnv } = signedIn();
    const created = await call("/v1/installations", { body: SERVER_BODY, env: cloudEnv, method: "POST", token: TOKEN });
    const { credential } = await created.json<{ credential: string }>();
    const before = stub.requests.length;
    for (const path of ["/v1/me", "/v1/installations"]) {
      expect((await call(path, { env: cloudEnv, token: credential })).status).toBe(401);
    }
    expect(stub.requests).toHaveLength(before);
  });

  it("answers 401 on every account route once Seira Cloud ends the session", async () => {
    const { stub, cloudEnv } = signedIn();
    const created = await call("/v1/installations", { body: SERVER_BODY, env: cloudEnv, method: "POST", token: TOKEN });
    const { installation } = await created.json<{ installation: { id: string } }>();

    stub.override = "unauthorized";
    const routes: Array<[string, string]> = [
      ["GET", "/v1/me"],
      ["GET", "/v1/installations"],
      ["POST", "/v1/installations"],
      ["POST", `/v1/installations/${installation.id}/credentials/rotate`],
      ["DELETE", `/v1/installations/${installation.id}`],
    ];
    for (const [method, path] of routes) {
      const response = await call(path, {
        body: method === "POST" && path === "/v1/installations" ? { ...SERVER_BODY, clientInstanceId: "server-2" } : undefined,
        env: cloudEnv,
        method,
        token: TOKEN,
      });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
    expect(await count("SELECT COUNT(*) AS n FROM installations WHERE revoked_at IS NULL")).toBe(1);
  });

  it("blocks an account: its installations end, its routes answer 403, and a new one is refused", async () => {
    const { cloudEnv } = signedIn();
    const created = await call("/v1/installations", { body: SERVER_BODY, env: cloudEnv, method: "POST", token: TOKEN });
    const { credential } = await created.json<{ credential: string }>();
    await env.DB.prepare(
      `INSERT INTO installation_push_devices (installation_id, token_hash, platform, token, environment, created_at, updated_at)
       SELECT id, ?, 'fcm', ?, 'production', 1, 1 FROM installations`,
    ).bind("a".repeat(64), `fcm:${"x".repeat(80)}`).run();
    expect(await count("SELECT COUNT(*) AS n FROM installation_push_devices")).toBe(1);

    await env.DB.prepare("INSERT INTO account_blocks (user_id, reason, created_at) VALUES (?, 'abuse', ?)")
      .bind(ACCOUNT, Date.now()).run();

    expect(await count("SELECT COUNT(*) AS n FROM installations WHERE revoked_at IS NULL")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM installation_credentials WHERE revoked_at IS NULL")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM installation_push_devices")).toBe(0);
    expect((await call("/v1/installations/self/endpoint", { env: cloudEnv, token: credential })).status).toBe(401);

    for (const [method, path] of [["GET", "/v1/me"], ["GET", "/v1/installations"]] as const) {
      const response = await call(path, { env: cloudEnv, method, token: TOKEN });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "account_blocked" });
    }
    const again = await call("/v1/installations", {
      body: { ...SERVER_BODY, clientInstanceId: "server-2" },
      env: cloudEnv,
      method: "POST",
      token: TOKEN,
    });
    expect(again.status).toBe(403);
    expect(await again.json()).toEqual({ error: "account_blocked" });
    expect(await count("SELECT COUNT(*) AS n FROM installations")).toBe(1);
  });

  it("refuses an installation insert for a blocked owner even when the request passed the account check first", async () => {
    await env.DB.prepare("INSERT INTO account_blocks (user_id, reason, created_at) VALUES (?, '', ?)")
      .bind(ACCOUNT, Date.now()).run();
    await env.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, \'\', ?, 1, 1, 1)')
      .bind(ACCOUNT, `${ACCOUNT}@seira-cloud.invalid`).run();
    await expect(env.DB.prepare(
      `INSERT INTO installations (id, owner_user_id, client_instance_id, display_name, platform, created_at, updated_at)
       VALUES ('i1', ?, 'c1', 'n', 'linux', 1, 1)`,
    ).bind(ACCOUNT).run()).rejects.toThrow(/account_blocked/);
  });

  it("lets an unblocked account sign in again, with its earlier installations still ended", async () => {
    const { cloudEnv } = signedIn();
    const created = await call("/v1/installations", { body: SERVER_BODY, env: cloudEnv, method: "POST", token: TOKEN });
    expect(created.status).toBe(201);
    await env.DB.prepare("INSERT INTO account_blocks (user_id, reason, created_at) VALUES (?, '', ?)")
      .bind(ACCOUNT, Date.now()).run();
    await env.DB.prepare("DELETE FROM account_blocks WHERE user_id = ?").bind(ACCOUNT).run();

    expect(await count("SELECT COUNT(*) AS n FROM installations WHERE revoked_at IS NULL")).toBe(0);
    const again = await call("/v1/installations", { body: SERVER_BODY, env: cloudEnv, method: "POST", token: TOKEN });
    expect(again.status).toBe(201);
  });
});
