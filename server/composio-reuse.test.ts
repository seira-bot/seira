// A fresh personal installation that connects a Composio project an earlier installation used picks up that installation's
// Composio user, so the apps connected there come back without connecting each one again. A server several people share never looks.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prepareProjectSession } from "./composio.ts";
import { forgetProjectAuthConfigs } from "./composio-project.ts";
import { createConfigRoutes, type ConfigRouteDeps } from "./routes/config.ts";

let api: Server;
let accounts: Array<Record<string, unknown>> = [];
let accountsDown = false;
let sessionsRefused = false;
const accountQueries: URLSearchParams[] = [];
const sessionUsers: string[] = [];

beforeAll(async () => {
  api = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.headers["x-api-key"] !== "ak_reuse") return json(401, { error: { message: "invalid project key" } });
    if (req.method === "GET" && url.pathname === "/api/v3.1/auth_configs") return json(200, { items: [] });
    if (req.method === "GET" && url.pathname === "/api/v3.1/connected_accounts") {
      accountQueries.push(url.searchParams);
      if (accountsDown) return json(503, { error: { message: "accounts unavailable" } });
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const items = accounts.slice(start, start + 2);
      return json(200, { items, next_cursor: start + 2 < accounts.length ? String(start + 2) : null });
    }
    if (req.method === "POST" && url.pathname === "/api/v3.1/tool_router/session") {
      sessionUsers.push(body.user_id);
      if (sessionsRefused) return json(503, { error: { message: "sessions unavailable" } });
      return json(201, {
        session_id: `trs_${sessionUsers.length}`,
        mcp: { type: "http", url: `https://app.composio.dev/tool_router/v3/trs_${sessionUsers.length}/mcp` },
        config: { user_id: body.user_id, multi_account: body.multi_account, auth_configs: {} },
      });
    }
    return json(404, { error: { message: "not found" } });
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  process.env.SEIRA_COMPOSIO_API = `http://127.0.0.1:${(api.address() as { port: number }).port}/api/v3.1`;
});

afterAll(async () => {
  delete process.env.SEIRA_COMPOSIO_API;
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

beforeEach(() => {
  forgetProjectAuthConfigs();
  accounts = [];
  accountsDown = false;
  sessionsRefused = false;
  accountQueries.length = 0;
  sessionUsers.length = 0;
});

const account = (user_id: string, slug: string, status = "ACTIVE") => ({ id: `ca_${user_id}_${slug}`, user_id, status, toolkit: { slug } });
const NEW_USER = /^seira_[0-9a-f-]{36}$/u;
/** Installation users as an installation makes them: the prefix and a random UUID. */
const EARLIER = "seira_0b5a6c1e-2f3d-4a5b-8c6d-7e8f9a0b1c2d", OLD_EARLIER = "openmausbot_5e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b";
const GONE = "seira_1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f", OTHER = "seira_2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a";
const ONE = "seira_3e4f5a6b-7c8d-4e9f-0a1b-2c3d4e5f6a7b", TWO = "seira_4f5a6b7c-8d9e-4f0a-1b2c-3d4e5f6a7b8c";
const prepareFresh = () => prepareProjectSession("ak_reuse", undefined, undefined, { reuseEarlierUser: true });

describe("a fresh installation connecting a project an earlier installation used", () => {
  it("keeps the earlier installation's Composio user, so its connected apps come back", async () => {
    accounts = [
      account(EARLIER, "gmail"),
      account(EARLIER, "github"),
      account(EARLIER, "slack"),
      account("someone_elses_app", "notion"),
    ];
    const prepared = await prepareFresh();
    expect(prepared.userId).toBe(EARLIER);
    expect(sessionUsers).toEqual([EARLIER]);
    expect(accountQueries.length).toBe(2);
    expect(accountQueries.every((query) => !query.has("user_ids"))).toBe(true);
  });

  it("keeps a Composio user that an earlier version made", async () => {
    accounts = [account(OLD_EARLIER, "gmail"), account(OLD_EARLIER, "slack")];
    const prepared = await prepareFresh();
    expect(prepared.userId).toBe(OLD_EARLIER);
  });

  it("never adopts a team member's Composio user or a connected-apps service user on the same key", async () => {
    for (const user of [`seira_member_${"a".repeat(32)}`, `seira_${"b".repeat(32)}`, `omb_member_${"c".repeat(32)}`, `omb_${"d".repeat(32)}`, `${EARLIER}-x`]) {
      accounts = [account(user, "gmail"), account(user, "slack")];
      const prepared = await prepareFresh();
      expect(prepared.userId, user).toMatch(NEW_USER);
      expect(prepared.userId, user).not.toBe(user);
    }
  });

  it("reads only a few pages, and starts a new user when the project is too big to tell", async () => {
    accounts = Array.from({ length: 30 }, (_, n) => account(EARLIER, `app${n}`));
    const prepared = await prepareFresh();
    expect(prepared.userId).toMatch(NEW_USER);
    expect(accountQueries.length).toBe(4);
  });

  it("starts a new user when the project has no earlier installation's live connections", async () => {
    accounts = [account("someone_elses_app", "notion"), account(GONE, "gmail", "EXPIRED")];
    const prepared = await prepareFresh();
    expect(prepared.userId).toMatch(NEW_USER);
  });

  it("starts a new user when several earlier installations share the project, since it can't tell whose apps are whose", async () => {
    accounts = [
      account(ONE, "gmail"),
      account(TWO, "github"),
      account("someone_elses_app", "notion"),
      account("someone_elses_app", "slack"),
    ];
    const prepared = await prepareFresh();
    expect(prepared.userId).toMatch(NEW_USER);
    expect(accountQueries.length).toBe(1);
  });

  it("starts a new user when another installation's connections have only expired", async () => {
    accounts = [account(EARLIER, "gmail"), account(OTHER, "github", "EXPIRED")];
    const prepared = await prepareFresh();
    expect(prepared.userId).toMatch(NEW_USER);
  });

  it("still connects, as a new user, when Composio can't list the project's connections", async () => {
    accountsDown = true;
    const prepared = await prepareFresh();
    expect(prepared.userId).toMatch(NEW_USER);
    expect(sessionUsers).toEqual([prepared.userId]);
  });

  it("never looks for another user when this installation already has one", async () => {
    accounts = [account(EARLIER, "gmail")];
    const prepared = await prepareProjectSession("ak_reuse", { userId: "seira_mine" }, undefined, { reuseEarlierUser: true });
    expect(prepared.userId).toBe("seira_mine");
    expect(accountQueries).toEqual([]);
  });
});

describe("who may look for an earlier installation's user", () => {
  const earlier = () => { accounts = [account(EARLIER, "gmail"), account(EARLIER, "slack")]; };

  // Composio refuses the Session, so the route answers before it saves anything.
  async function saveKeyThroughConfigRoute(shared: boolean) {
    sessionsRefused = true;
    const replies: Array<{ status: number; body: unknown }> = [];
    const deps = {
      sharedMembership: () => shared,
      cfg: {},
      hostedModels: false,
      cloudHome: false,
      store: { bots: [] },
      browserRuntime: { heldBy: () => false },
      providerConfigBusy: { get: () => false, set: () => undefined },
      localVmModeChangeBusy: { set: () => undefined },
      computerProviderConfigTransitions: { add: () => undefined, delete: () => undefined },
    } as unknown as ConfigRouteDeps;
    await createConfigRoutes(deps)({
      req: {},
      res: {},
      url: new URL("http://host/api/config"),
      path: "/api/config",
      method: "PUT",
      auth: {},
      json: (_res: unknown, status: number, body: unknown) => { replies.push({ status, body }); },
      readBody: async () => ({ composio: { apiKey: "ak_reuse" } }),
    } as unknown as Parameters<ReturnType<typeof createConfigRoutes>>[0]);
    return replies;
  }

  it("does not look unless the caller asks, so setting up a Session later never adopts anyone", async () => {
    earlier();
    const prepared = await prepareProjectSession("ak_reuse");
    expect(prepared.userId).toMatch(NEW_USER);
    expect(accountQueries).toEqual([]);
  });

  it("makes no account listing on a server several people share, and starts a new user", async () => {
    earlier();
    const replies = await saveKeyThroughConfigRoute(true);
    expect(replies.map((reply) => reply.status)).toEqual([400]);
    expect(accountQueries).toEqual([]);
    expect(sessionUsers).toHaveLength(1);
    expect(sessionUsers[0]).toMatch(NEW_USER);
  });

  it("looks on a personal installation, and keeps the earlier user", async () => {
    earlier();
    await saveKeyThroughConfigRoute(false);
    expect(accountQueries.length).toBeGreaterThan(0);
    expect(sessionUsers).toEqual([EARLIER]);
  });
});
