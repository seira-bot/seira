import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addressKey, forgetLimitSettings, toolUnits } from "./limits";
import { brokerHarness, type Installation } from "./test-harness";
import { forgetTriggerTypes } from "./triggers";

let h: ReturnType<typeof brokerHarness>;

beforeEach(() => {
  forgetLimitSettings();
  forgetTriggerTypes();
  h = brokerHarness();
  vi.stubGlobal("fetch", h.composio.fetchImpl);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Writes one broker setting as the owner would with `wrangler d1 execute`, and drops this isolate's cached copy. */
function setting(key: string, value: string, { forget = true } = {}) {
  h.d1.db.prepare(
    "INSERT INTO broker_settings (key, value, updated_at) VALUES (?, ?, 0) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
  if (forget) forgetLimitSettings();
}

/** A multi-execute argument that runs `inner` as a nested multi-execute call, plus one more tool. */
const nest = (inner: Record<string, unknown>) => ({ tools: [{ tool_slug: "composio_multi_execute_tool", arguments: inner }, { tool_slug: "X" }] });

let rpcId = 0;
function toolCall(name = "GMAIL_SEND_EMAIL", args: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } };
}

function mcp(owner: Installation, message: unknown) {
  return h.call(owner, "/v1/mcp", { method: "POST", body: typeof message === "string" ? message : JSON.stringify(message) });
}

const forwarded = () => h.composio.calls.filter((call) => call.path.endsWith("/mcp")).length;

function usage(installationId: string) {
  return h.d1.rows<Record<string, number>>(
    "SELECT tool_calls, connect_links, refused_quota, refused_fleet, refused_paused FROM usage_days WHERE installation_id = ?",
    installationId,
  )[0];
}

async function refusalText(response: Response) {
  expect(response.status).toBe(200);
  const body = await response.json() as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
  expect(body.result?.isError).toBe(true);
  return body.result!.content![0]!.text;
}

function register(ip?: string) {
  return h.fetch("/v1/installations", { method: "POST", body: "{}", headers: ip ? { "cf-connecting-ip": ip } : {} });
}

describe("tool units", () => {
  it("counts tool units", () => {
    expect(toolUnits(toolCall())).toBe(1);
    expect(toolUnits(toolCall("composio_search_tools"))).toBe(0);
    expect(toolUnits(toolCall("COMPOSIO_SEARCH_TOOLS"))).toBe(0);
    const three = { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: {} }, { tool_slug: "SLACK_SEND", arguments: {} }, { tool_slug: "X", arguments: {} }] };
    expect(toolUnits(toolCall("COMPOSIO_MULTI_EXECUTE_TOOL", three))).toBe(3);
    expect(toolUnits(toolCall("COMPOSIO_MULTI_EXECUTE_TOOL", {}))).toBe(1);
    expect(toolUnits(toolCall("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [] }))).toBe(1);
    expect(toolUnits({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toBe(0);
    expect(toolUnits({ jsonrpc: "2.0", method: "notifications/initialized" })).toBe(0);
    expect(toolUnits([toolCall(), toolCall("COMPOSIO_SEARCH_TOOLS"), toolCall("COMPOSIO_MULTI_EXECUTE_TOOL", three)])).toBe(4);
    expect(toolUnits(null)).toBe(0);
    expect(toolUnits("tools/call")).toBe(0);
    expect(toolUnits({ method: "tools/call" })).toBe(1);
    // A workbench call can run many tools at Composio, so it counts as `units.workbench` tool calls (at least 1).
    expect(toolUnits(toolCall("COMPOSIO_REMOTE_WORKBENCH"))).toBe(10);
    expect(toolUnits(toolCall("composio_remote_bash_tool"), 3)).toBe(3);
    expect(toolUnits(toolCall("COMPOSIO_REMOTE_WORKBENCH"), 0)).toBe(1);
    // Inside multi-execute, a workbench slug keeps its weight and a free slug is not free.
    const mixed = { tools: [{ tool_slug: "COMPOSIO_REMOTE_WORKBENCH" }, { tool_slug: "COMPOSIO_SEARCH_TOOLS" }, {}] };
    expect(toolUnits(toolCall("COMPOSIO_MULTI_EXECUTE_TOOL", mixed))).toBe(12);
    // A nested multi-execute item counts by its own items.
    expect(toolUnits(toolCall("COMPOSIO_MULTI_EXECUTE_TOOL", nest(three)))).toBe(4);
    expect(toolUnits(toolCall("COMPOSIO_MULTI_EXECUTE_TOOL", nest(nest(three))))).toBe(5);
  });

  it("keys an IPv6 address by its /64 and an IPv4 address whole", () => {
    expect(addressKey("203.0.113.7")).toBe("203.0.113.7");
    expect(addressKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(addressKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:0DB8:0001:0002:ffff:eeee:dddd:cccc")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(addressKey("::1")).toBe("0:0:0:0::/64");
  });
});

describe("per-installation quotas (FR-147)", () => {
  it("refuses a tool call over the daily quota", async () => {
    setting("quota.tool_calls.desktop", "2");
    const owner = await h.install();
    h.account(owner);

    for (let index = 0; index < 2; index += 1) {
      const response = await mcp(owner, toolCall());
      expect(response.status).toBe(200);
      expect((await response.json() as { result: { isError?: boolean } }).result.isError).toBeUndefined();
    }
    expect(forwarded()).toBe(2);
    const text = await refusalText(await mcp(owner, toolCall()));
    expect(text).toMatch(/did not run/);
    expect(text).toMatch(/Settings → AI → Other services/);
    expect(text).not.toMatch(/usage_days|quota\.|\/v1\//);
    expect(forwarded()).toBe(2);
    expect(usage(owner.id)).toMatchObject({ tool_calls: 2, refused_quota: 1 });

    // Free messages still pass, and another installation has its own quota.
    expect((await mcp(owner, { jsonrpc: "2.0", id: 99, method: "tools/list" })).status).toBe(200);
    expect((await mcp(owner, toolCall("COMPOSIO_SEARCH_TOOLS"))).status).toBe(200);
    expect(forwarded()).toBe(4);
    const other = await h.install();
    expect((await (await mcp(other, toolCall())).json() as { result: { isError?: boolean } }).result.isError).toBeUndefined();
  });

  it("counts a workbench call as many tool calls, and the owner can turn the workbench off", async () => {
    setting("quota.tool_calls.desktop", "25");
    const owner = await h.install();
    h.account(owner);
    const passed = async (message: unknown, by = owner) => (await (await mcp(by, message)).json() as { result: { isError?: boolean } }).result.isError === undefined;

    expect(await passed(toolCall("COMPOSIO_REMOTE_WORKBENCH"))).toBe(true);
    expect(await passed(toolCall("COMPOSIO_REMOTE_BASH_TOOL"))).toBe(true);
    expect(await refusalText(await mcp(owner, toolCall("COMPOSIO_REMOTE_WORKBENCH")))).toMatch(/all of today's app actions/);
    expect(await passed(toolCall())).toBe(true);
    expect(usage(owner.id)).toMatchObject({ tool_calls: 21, refused_quota: 1 });

    setting("tools.workbench", "off");
    const other = await h.install();
    h.account(other);
    const text = await refusalText(await mcp(other, toolCall("COMPOSIO_REMOTE_WORKBENCH")));
    expect(text).toMatch(/remote workbench/);
    expect(text).toMatch(/Settings → AI → Other services/);
    const batch = [toolCall(), toolCall("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "COMPOSIO_REMOTE_BASH_TOOL" }] })];
    expect((await (await mcp(other, batch)).json() as unknown[]).length).toBe(2);
    expect(await passed(toolCall(), other)).toBe(true);
    expect(usage(other.id)).toMatchObject({ tool_calls: 1, refused_quota: 2 });
    expect(forwarded()).toBe(4);
  });

  it("gives a Cloud installation the Cloud quota and starts again each UTC day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T23:59:00Z"));
    setting("quota.tool_calls.desktop", "1");
    setting("quota.tool_calls.cloud", "3");
    const cloud = await h.install();
    h.d1.db.prepare("UPDATE installations SET cloud_machine_id = 'seira-machine-1' WHERE id = ?").run(cloud.id);

    for (let index = 0; index < 3; index += 1) await mcp(cloud, toolCall());
    expect(forwarded()).toBe(3);
    await refusalText(await mcp(cloud, toolCall()));

    vi.setSystemTime(new Date("2026-11-21T00:00:01Z"));
    expect((await (await mcp(cloud, toolCall())).json() as { result: { isError?: boolean } }).result.isError).toBeUndefined();
    expect(h.d1.rows("SELECT day, tool_calls FROM usage_days WHERE installation_id = ? ORDER BY day", cloud.id)).toEqual([
      { day: "2026-11-20", tool_calls: 3 },
      { day: "2026-11-21", tool_calls: 1 },
    ]);
  });

  it("does not let parallel calls pass the quota", async () => {
    setting("quota.tool_calls.desktop", "3");
    const owner = await h.install();
    const responses = await Promise.all(Array.from({ length: 8 }, () => mcp(owner, toolCall())));
    const errors = await Promise.all(responses.map(async (response) => (await response.json() as { result: { isError?: boolean } }).result.isError === true));
    expect(errors.filter((error) => !error)).toHaveLength(3);
    expect(forwarded()).toBe(3);
    expect(usage(owner.id)).toMatchObject({ tool_calls: 3, refused_quota: 5 });
  });

  it("counts a multi-execute call by its tools and refuses a batch over the quota whole", async () => {
    setting("quota.tool_calls.desktop", "4");
    const owner = await h.install();
    const tools = Array.from({ length: 3 }, () => ({ tool_slug: "GMAIL_SEND_EMAIL", arguments: {} }));
    expect((await mcp(owner, toolCall("COMPOSIO_MULTI_EXECUTE_TOOL", { tools }))).status).toBe(200);
    expect(usage(owner.id)).toMatchObject({ tool_calls: 3 });

    const batch = [toolCall(), toolCall()];
    const response = await mcp(owner, batch);
    expect(response.status).toBe(200);
    const replies = await response.json() as Array<{ id: number; result: { isError: boolean } }>;
    expect(replies.map((reply) => reply.id)).toEqual(batch.map((call) => call.id));
    expect(replies.every((reply) => reply.result.isError)).toBe(true);
    expect(forwarded()).toBe(1);
    expect(usage(owner.id)).toMatchObject({ tool_calls: 3, refused_quota: 1 });

    // One unit is left: a single call still fits.
    expect((await (await mcp(owner, toolCall())).json() as { result: { isError?: boolean } }).result.isError).toBeUndefined();
  });

  it("refuses multi-execute calls nested past three levels, with every limit off", async () => {
    for (const key of ["quota.tool_calls.desktop", "budget.tool_calls_per_day"]) setting(key, "0");
    const owner = await h.install();
    h.account(owner);
    const three = { tools: [{ tool_slug: "A" }, { tool_slug: "B" }, { tool_slug: "C" }] };
    expect(await refusalText(await mcp(owner, toolCall("COMPOSIO_MULTI_EXECUTE_TOOL", nest(nest(nest(three))))))).toMatch(/three levels/);
    expect(forwarded()).toBe(0);
    expect(usage(owner.id)).toMatchObject({ tool_calls: 0, refused_quota: 1 });
    expect((await (await mcp(owner, toolCall("COMPOSIO_MULTI_EXECUTE_TOOL", nest(nest(three))))).json() as { result: { isError?: boolean } }).result.isError).toBeUndefined();
    expect(forwarded()).toBe(1);
  });

  it("forwards what it counted and refuses a body that is not JSON", async () => {
    setting("quota.tool_calls.desktop", "1");
    const owner = await h.install();
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/mcp")) bodies.push(new TextDecoder().decode(init?.body as Uint8Array));
      return h.composio.fetchImpl(input, init);
    });

    // A duplicate key: the broker counts the last "method", so it must send only that one.
    const sneaky = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"GMAIL_SEND_EMAIL"},"method":"tools/call"}';
    expect((await mcp(owner, sneaky)).status).toBe(200);
    expect(bodies).toEqual(['{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"GMAIL_SEND_EMAIL"}}']);
    const listedFirst = '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"name":"GMAIL_SEND_EMAIL"},"method":"tools/call"}';
    await refusalText(await mcp(owner, listedFirst));
    expect(bodies).toHaveLength(1);

    const broken = await mcp(owner, '{"jsonrpc":"2.0","method":');
    expect(broken.status).toBe(400);
    await expect(broken.json()).resolves.toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32700 } });
    expect(bodies).toHaveLength(1);
  });

  it("limits sign-in links per day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T23:00:00Z"));
    setting("quota.connect_links", "2");
    const owner = await h.install();
    const authorize = () => h.call(owner, "/v1/connectors/gmail/authorize", { method: "POST", body: "{}" });

    expect((await authorize()).status).toBe(200);
    expect((await authorize()).status).toBe(200);
    const links = h.composio.calls.filter((call) => call.path.endsWith("/link")).length;
    const refused = await authorize();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("3600");
    const { error } = await refused.json() as { error: string };
    expect(error).not.toMatch(/quota|limit|\/v1\//i);
    expect(h.composio.calls.filter((call) => call.path.endsWith("/link")).length).toBe(links);
    expect(usage(owner.id)).toMatchObject({ connect_links: 2, refused_quota: 1 });
  });

  it("caps triggers per installation", async () => {
    setting("quota.triggers", "2");
    const owner = await h.install();
    const account = h.account(owner);
    const first = await h.createTrigger(owner, account, { query: "a" });
    expect(first.response.status).toBe(201);
    expect((await h.createTrigger(owner, account, { query: "b" })).response.status).toBe(201);

    const upserts = h.composio.callsTo("/trigger_instances/").length;
    const third = await h.createTrigger(owner, account, { query: "c" });
    expect(third.response.status).toBe(409);
    expect(third.body.error).toMatch(/Remove a trigger/);
    expect(h.composio.callsTo("/trigger_instances/").length).toBe(upserts);

    expect((await h.call(owner, `/v1/triggers/${first.body.triggerId}`, { method: "DELETE" })).status).toBe(200);
    expect((await h.createTrigger(owner, account, { query: "c" })).response.status).toBe(201);
  });

  it("limits registrations per address per day", async () => {
    setting("quota.registrations_per_ip", "2");
    expect((await register("203.0.113.7")).status).toBe(201);
    expect((await register("203.0.113.7")).status).toBe(201);
    const refused = await register("203.0.113.7");
    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toEqual({ error: "too many registration attempts" });
    expect((await register("::ffff:203.0.113.7")).status).toBe(429);
    expect((await register("203.0.113.8")).status).toBe(201);

    expect((await register("2001:db8:1:2::1")).status).toBe(201);
    expect((await register("2001:db8:1:2::ffff")).status).toBe(201);
    expect((await register("2001:db8:1:2:aaaa::1")).status).toBe(429);
    expect((await register("2001:db8:1:3::1")).status).toBe(201);

    expect(h.d1.rows("SELECT COUNT(*) AS n FROM installations")).toEqual([{ n: 6 }]);
    const sources = h.d1.rows<{ source: string; registrations: number; refused: number }>(
      "SELECT source, registrations, refused FROM registration_days ORDER BY registrations DESC, refused DESC",
    );
    expect(sources.map(({ registrations, refused: count }) => [registrations, count])).toEqual([[2, 2], [2, 1], [1, 0], [1, 0]]);
    expect(sources.every(({ source }) => /^[0-9a-f]{64}$/.test(source))).toBe(true);
  });

  it("keeps usage totals over an erase", async () => {
    const owner = await h.install();
    await mcp(owner, toolCall());
    await mcp(owner, toolCall());
    const erased = await h.call(owner, "/v1/installation", { method: "DELETE" });
    expect(erased.status).toBe(200);
    expect(usage(owner.id)).toBeUndefined();
    expect(usage("")).toMatchObject({ tool_calls: 2 });
  });
});

describe("kill switch and fleet budget (FR-148)", () => {
  it("pause new: refuses new installations, sign-in links and triggers, and keeps tools working", async () => {
    const owner = await h.install();
    const account = h.account(owner);
    setting("pause", "new");

    expect((await register("203.0.113.9")).status).toBe(503);
    const link = await h.call(owner, "/v1/connectors/gmail/authorize", { method: "POST", body: "{}" });
    expect(link.status).toBe(503);
    expect(link.headers.get("retry-after")).toBe("300");
    expect((await h.createTrigger(owner, account)).response.status).toBe(503);
    expect((await (await mcp(owner, toolCall())).json() as { result: { isError?: boolean } }).result.isError).toBeUndefined();
    expect((await h.call(owner, "/v1/connectors/connected")).status).toBe(200);
    // The relay's sign-in meta tool stops too, also inside a batch.
    expect(await refusalText(await mcp(owner, toolCall("COMPOSIO_MANAGE_CONNECTIONS", { toolkits: ["gmail"] })))).toMatch(/paused/);
    const batch = await (await mcp(owner, [toolCall(), toolCall("composio_manage_connections")])).json() as Array<{ result: { isError?: boolean } }>;
    expect(batch.map((reply) => reply.result.isError)).toEqual([true, true]);
    // So does the workbench, which can start sign-ins the broker cannot see.
    expect(await refusalText(await mcp(owner, toolCall("COMPOSIO_REMOTE_WORKBENCH")))).toMatch(/paused/);
    expect(usage(owner.id)).toMatchObject({ tool_calls: 1, refused_paused: 3 });
    expect(forwarded()).toBe(1);
  });

  it("pause tools: refuses each billable tool call and passes the free messages", async () => {
    const owner = await h.install();
    setting("pause", "tools");

    expect(await refusalText(await mcp(owner, toolCall()))).toMatch(/paused/);
    expect((await mcp(owner, { jsonrpc: "2.0", id: 5, method: "tools/list" })).status).toBe(200);
    expect((await mcp(owner, toolCall("COMPOSIO_SEARCH_TOOLS"))).status).toBe(200);
    expect(forwarded()).toBe(2);
    expect(usage(owner.id)).toMatchObject({ tool_calls: 0, refused_paused: 1 });
    expect((await h.call(owner, "/v1/catalog")).status).not.toBe(503);
  });

  it("pause all: stops each route that reaches Composio except the ones that remove data", async () => {
    const owner = await h.install();
    const account = h.account(owner);
    const trigger = await h.createTrigger(owner, account);
    setting("pause", "all");
    const before = h.composio.calls.length;

    for (const [path, init] of [
      ["/v1/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }],
      ["/v1/catalog", {}],
      ["/v1/connectors", {}],
      ["/v1/connectors/connected", {}],
      ["/v1/connectors/gmail/authorize", { method: "POST", body: "{}" }],
      ["/v1/triggers", {}],
      ["/v1/trigger-types?toolkits=gmail", {}],
      [`/v1/triggers/${trigger.body.triggerId}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) }],
      ["/v1/files/upload", { method: "POST", body: "{}" }],
    ] as const) {
      const response = await h.call(owner, path, init);
      expect([path, response.status]).toEqual([path, 503]);
    }
    expect(h.composio.calls.length).toBe(before);
    expect((await h.call(owner, "/v1/me")).status).toBe(200);
    expect((await h.poll(owner)).status).toBe(200);
    expect((await h.call(owner, `/v1/triggers/${trigger.body.triggerId}`, { method: "DELETE" })).status).toBe(200);
    expect((await h.call(owner, "/v1/connectors/gmail", { method: "DELETE" })).status).not.toBe(503);

    setting("pause", "none");
    expect((await h.call(owner, "/v1/connectors/connected")).status).toBe(200);
  });

  it("reads settings again after 30 seconds, without a redeploy", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T10:00:00Z"));
    const owner = await h.install();
    expect((await mcp(owner, toolCall())).status).toBe(200);
    setting("pause", "tools", { forget: false });

    vi.setSystemTime(new Date("2026-11-20T10:00:29Z"));
    expect((await (await mcp(owner, toolCall())).json() as { result: { isError?: boolean } }).result.isError).toBeUndefined();
    vi.setSystemTime(new Date("2026-11-20T10:00:31Z"));
    await refusalText(await mcp(owner, toolCall()));
  });

  it("falls back to the default for a bad value and treats 0 as no limit", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    setting("quota.tool_calls.desktop", "many");
    setting("pause", "stop");
    const owner = await h.install();
    expect((await (await mcp(owner, toolCall())).json() as { result: { isError?: boolean } }).result.isError).toBeUndefined();
    const logged = errors.mock.calls.map(([line]) => String(line)).join("\n");
    expect(logged).toMatch(/quota\.tool_calls\.desktop/);
    expect(logged).toMatch(/pause/);

    setting("quota.tool_calls.desktop", "0");
    setting("budget.tool_calls_per_day", "0");
    h.d1.db.prepare(
      "INSERT INTO usage_days (day, installation_id, tool_calls) VALUES (?, ?, 1000000) ON CONFLICT (day, installation_id) DO UPDATE SET tool_calls = excluded.tool_calls",
    ).run(new Date().toISOString().slice(0, 10), owner.id);
    expect((await (await mcp(owner, toolCall())).json() as { result: { isError?: boolean } }).result.isError).toBeUndefined();
  });

  it("stops the fleet at the daily budget", async () => {
    setting("quota.tool_calls.desktop", "10");
    setting("budget.tool_calls_per_day", "3");
    const first = await h.install();
    const second = await h.install();
    await mcp(first, toolCall());
    await mcp(first, toolCall());
    await mcp(second, toolCall());
    expect(forwarded()).toBe(3);

    expect(await refusalText(await mcp(second, toolCall()))).toMatch(/shared/);
    expect(forwarded()).toBe(3);
    expect(usage(second.id)).toMatchObject({ tool_calls: 1, refused_fleet: 1 });
  });

  it("fails open without migration 0007", async () => {
    h = brokerHarness({ migrations: 5 });
    vi.stubGlobal("fetch", h.composio.fetchImpl);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const owner = (await register("203.0.113.10")).status;
    expect(owner).toBe(201);
    const installation = await h.install();
    // Before h.account: an account already connected to the toolkit makes authorize answer 400.
    expect((await h.call(installation, "/v1/connectors/gmail/authorize", { method: "POST", body: "{}" })).status).toBe(200);
    h.account(installation);
    expect((await (await mcp(installation, toolCall())).json() as { result: { isError?: boolean } }).result.isError).toBeUndefined();
    expect(forwarded()).toBe(1);
    expect(errors.mock.calls.some(([line]) => String(line).includes("usage limits unavailable"))).toBe(true);
  });
});
