import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "./index";
import { forgetLimitSettings, NUMBER_SETTINGS } from "./limits";
import { brokerHarness, STATS_TOKEN } from "./test-harness";
import { costEstimate, watchUsage } from "./usage";

let h: ReturnType<typeof brokerHarness>;
let posts: Array<{ url: string; body: Record<string, unknown> }>;
let webhookStatus: number;

const HOOK = "https://hooks.example.test/services/T000/B000/hook-secret";

beforeEach(() => {
  forgetLimitSettings();
  h = brokerHarness();
  posts = [];
  webhookStatus = 200;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://backend.composio.dev/")) {
      posts.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response("ok", { status: webhookStatus });
    }
    return h.composio.fetchImpl(input, init);
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setting(key: string, value: string) {
  h.d1.db.prepare(
    "INSERT INTO broker_settings (key, value, updated_at) VALUES (?, ?, 0) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
  forgetLimitSettings();
}

function usageRow(day: string, installationId: string, counts: Record<string, number>) {
  const columns = Object.keys(counts);
  h.d1.db.prepare(
    `INSERT INTO usage_days (day, installation_id, ${columns.join(", ")}) VALUES (?, ?, ${columns.map(() => "?").join(", ")})
     ON CONFLICT (day, installation_id) DO UPDATE SET ${columns.map((column) => `${column} = excluded.${column}`).join(", ")}`,
  ).run(day, installationId, ...Object.values(counts));
}

function eventRow(day: string, installationId: string, counts: Record<string, number>) {
  const columns = Object.keys(counts);
  h.d1.db.prepare(`INSERT INTO app_event_days (day, installation_id, ${columns.join(", ")}) VALUES (?, ?, ${columns.map(() => "?").join(", ")})`)
    .run(day, installationId, ...Object.values(counts));
}

function registrationRow(day: string, source: string, registrations: number, refused = 0) {
  h.d1.db.prepare("INSERT INTO registration_days (day, source, registrations, refused) VALUES (?, ?, ?, ?)").run(day, source, registrations, refused);
}

const withHook = (extra: Record<string, unknown> = {}) => ({ ...h.env, ALERT_WEBHOOK_URL: HOOK, ...extra }) as never;
const alertKinds = (day: string) => h.d1.rows<{ kind: string }>("SELECT kind FROM usage_alerts WHERE day = ? ORDER BY kind", day).map(({ kind }) => kind);
const texts = () => posts.map((post) => String(post.body.text ?? post.body.content));

describe("usage metrics (FR-149)", () => {
  it("reports daily usage without installation ids", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
    const first = await h.install();
    const second = await h.install();
    usageRow("2026-10-31", first.id, { tool_calls: 1000 });
    usageRow("2026-11-01", first.id, { tool_calls: 100 });
    usageRow("2026-11-19", first.id, { tool_calls: 7 });
    usageRow("2026-11-20", first.id, { tool_calls: 5, connect_links: 1, refused_quota: 2 });
    usageRow("2026-11-20", second.id, { tool_calls: 3, refused_fleet: 1 });
    usageRow("2026-11-20", "", { tool_calls: 4 });
    registrationRow("2026-11-20", "a".repeat(64), 3, 1);
    eventRow("2026-11-20", first.id, { queued: 10, delivered: 9, duplicate: 1, dropped_daily_limit: 2 });
    eventRow("2026-11-20", "", { unrouted: 2 });

    expect((await h.fetch("/v1/stats/usage")).status).toBe(401);
    expect((await h.call(first, "/v1/stats/usage")).status).toBe(401);
    const auth = { headers: { authorization: `Bearer ${STATS_TOKEN}` } };
    expect((await h.fetch("/v1/stats/usage?days=0", auth)).status).toBe(400);
    const response = await h.fetch("/v1/stats/usage?days=2", auth);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(first.id);
    expect(text).not.toContain(second.id);
    expect(JSON.parse(text)).toMatchObject({
      days: [
        { day: "2026-11-19", toolCalls: 7, activeInstallations: 1, registrations: 0, appEvents: 0 },
        {
          day: "2026-11-20",
          toolCalls: 12,
          connectLinks: 1,
          refusedQuota: 2,
          refusedFleet: 1,
          refusedPaused: 0,
          activeInstallations: 2,
          registrations: 3,
          registrationsRefused: 1,
          appEvents: 15,
        },
      ],
      month: { from: "2026-11-01", toolCalls: 119, appEvents: 15, estimateUsd: 29 },
      pause: "none",
      settings: { "quota.tool_calls.desktop": NUMBER_SETTINGS["quota.tool_calls.desktop"], "budget.tool_calls_per_day": NUMBER_SETTINGS["budget.tool_calls_per_day"] },
    });

    h.env.STATS_TOKEN = undefined;
    expect((await h.fetch("/v1/stats/usage", auth)).status).toBe(404);
  });

  it("estimates the monthly bill from the price settings", () => {
    expect(costEstimate(NUMBER_SETTINGS, 0, 0)).toBe(29);
    expect(costEstimate(NUMBER_SETTINGS, 20_000, 10_000)).toBe(29);
    // 10K calls over at $2/1K plus 10K events over at $6/1K = $80; the $29 credit pays the first $29.
    expect(costEstimate(NUMBER_SETTINGS, 30_000, 20_000)).toBe(80);
    expect(costEstimate(NUMBER_SETTINGS, 35_000, 0)).toBe(30);
    expect(costEstimate({ ...NUMBER_SETTINGS, "price.usd_per_1k_tool_calls": 0.3, "price.tool_calls_included": 100_000 }, 180_000, 0)).toBe(29);
  });
});

describe("usage alerts (FR-149)", () => {
  it("alerts once per kind per UTC day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T08:23:00Z"));
    const owner = await h.install();
    setting("alert.daily_summary", "off");
    setting("budget.tool_calls_per_day", "10");
    usageRow("2026-11-20", owner.id, { tool_calls: 8 });

    await watchUsage(withHook(), Date.now());
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toMatch(/8 of 10 tool calls/);
    await watchUsage(withHook(), Date.now());
    expect(posts).toHaveLength(1);

    usageRow("2026-11-20", owner.id, { tool_calls: 10 });
    await watchUsage(withHook(), Date.now());
    expect(texts()[1]).toMatch(/budget reached/i);

    setting("pause", "tools");
    setting("alert.registrations_per_day", "2");
    registrationRow("2026-11-20", "b".repeat(64), 2);
    setting("alert.usd_per_month", "30");
    usageRow("2026-11-01", owner.id, { tool_calls: 40_000 });
    await watchUsage(withHook(), Date.now());
    expect(texts()).toHaveLength(5);
    expect(texts().slice(2).join("\n")).toMatch(/pause is "tools"/);
    expect(texts().slice(2).join("\n")).toMatch(/\$40\.02/);
    expect(texts().slice(2).join("\n")).toMatch(/2 new installations today/);
    expect(alertKinds("2026-11-20")).toEqual(["budget-near", "budget-reached", "month-cost", "paused", "registrations"]);
    for (const text of texts()) expect(text).not.toContain(owner.id);

    // A new UTC day: the conditions that still hold alert again, from the hourly cron.
    vi.setSystemTime(new Date("2026-11-21T00:23:00Z"));
    await worker.scheduled({ scheduledTime: Date.now() } as never, withHook());
    expect(alertKinds("2026-11-21")).toEqual(["month-cost", "paused"]);
  });

  it("shapes the alert for Telegram, Discord, and other webhooks", async () => {
    setting("alert.daily_summary", "off");
    setting("pause", "new");
    const fresh = () => h.d1.db.exec("DELETE FROM usage_alerts");

    await watchUsage(withHook({ ALERT_WEBHOOK_URL: "https://api.telegram.org/botTEST/sendMessage", ALERT_CHAT_ID: "-1001" }), Date.now());
    expect(posts.at(-1)?.body).toEqual({ chat_id: "-1001", text: expect.stringMatching(/pause is "new"/) });
    fresh();
    await watchUsage(withHook({ ALERT_WEBHOOK_URL: "https://discord.com/api/webhooks/1/abc" }), Date.now());
    expect(posts.at(-1)?.body).toEqual({ content: expect.stringMatching(/pause is "new"/) });
    fresh();
    await watchUsage(withHook(), Date.now());
    expect(posts.at(-1)?.body).toEqual({ text: expect.stringMatching(/pause is "new"/) });

    fresh();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await watchUsage(withHook({ ALERT_WEBHOOK_URL: "http://hooks.example.test/plain-secret" }), Date.now());
    expect(posts).toHaveLength(3);
    expect(errors.mock.calls.map(([line]) => String(line)).join("\n")).not.toContain("plain-secret");
  });

  it("sends yesterday's summary once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T00:23:00Z"));
    const first = await h.install();
    const second = await h.install();
    usageRow("2026-11-19", first.id, { tool_calls: 7, connect_links: 2 });
    usageRow("2026-11-19", second.id, { tool_calls: 3, refused_quota: 1 });
    eventRow("2026-11-19", first.id, { queued: 4, delivered: 4 });
    registrationRow("2026-11-19", "c".repeat(64), 2);

    await watchUsage(withHook(), Date.now());
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toMatch(/2026-11-19/);
    expect(texts()[0]).toMatch(/10 tool calls by 2 installations/);
    expect(texts()[0]).toMatch(/2 sign-in links, 4 trigger events, 2 new installations/);
    expect(texts()[0]).toMatch(/1 over a device limit/);

    vi.setSystemTime(new Date("2026-11-20T01:23:00Z"));
    await watchUsage(withHook(), Date.now());
    expect(posts).toHaveLength(1);
    expect(alertKinds("2026-11-20")).toEqual(["daily-summary"]);

    h.d1.db.exec("DELETE FROM usage_alerts");
    setting("alert.daily_summary", "off");
    await watchUsage(withHook(), Date.now());
    expect(posts).toHaveLength(1);
  });

  it("retries a failed alert next hour, and logs the alert without a webhook", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    setting("alert.daily_summary", "off");
    setting("pause", "all");

    webhookStatus = 500;
    await watchUsage(withHook(), Date.now());
    expect(posts).toHaveLength(1);
    expect(h.d1.rows("SELECT kind FROM usage_alerts")).toEqual([]);
    expect(errors.mock.calls.map(([line]) => String(line)).join("\n")).toMatch(/usage alert failed/);
    expect(errors.mock.calls.map(([line]) => String(line)).join("\n")).not.toContain("hook-secret");

    webhookStatus = 200;
    await watchUsage(withHook(), Date.now());
    expect(posts).toHaveLength(2);
    expect(h.d1.rows("SELECT kind FROM usage_alerts")).toEqual([{ kind: "paused" }]);

    h.d1.db.exec("DELETE FROM usage_alerts");
    const warnings = vi.mocked(console.warn);
    warnings.mockClear();
    await watchUsage(h.env as never, Date.now());
    await watchUsage(h.env as never, Date.now());
    expect(posts).toHaveLength(2);
    expect(warnings.mock.calls.filter(([line]) => String(line).includes('pause is \\"all\\"'))).toHaveLength(1);
  });

  it("never throws, even without migration 0007", async () => {
    h = brokerHarness({ migrations: 5 });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(watchUsage(withHook(), Date.now())).resolves.toBeUndefined();
    expect(errors.mock.calls.some(([line]) => String(line).includes("usage watch failed"))).toBe(true);
    expect(posts).toEqual([]);
  });

  it("keeps 90 days of usage, registrations and alerts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T03:23:00Z"));
    setting("alert.daily_summary", "off");
    for (const day of ["2026-08-21", "2026-08-22"]) {
      usageRow(day, "", { tool_calls: 1 });
      registrationRow(day, "d".repeat(64), 1);
      h.d1.db.prepare("INSERT INTO usage_alerts (day, kind, sent_at) VALUES (?, 'paused', 0)").run(day);
    }
    await watchUsage(withHook(), Date.now());
    for (const table of ["usage_days", "registration_days", "usage_alerts"]) {
      expect(h.d1.rows(`SELECT day FROM ${table} ORDER BY day`)).toEqual([{ day: "2026-08-22" }]);
    }
  });
});
