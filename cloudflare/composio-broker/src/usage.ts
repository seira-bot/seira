import { intParam, sameDigest } from "./app-events";
import { DAY_MS, json, sha256, utcDay } from "./common";
import { limitSettings, type NumberSetting } from "./limits";

const RETENTION_DAYS = 90;
const ALERT_TIMEOUT_MS = 10_000;
/** Each delivery Composio sent to the webhook. Composio bills per delivery, also for the ones the broker did not keep. */
const BILLED_EVENTS = "queued + duplicate + dropped_daily_limit + dropped_queue_full + unrouted";

interface DayCounts {
  day: string;
  toolCalls: number;
  connectLinks: number;
  refusedQuota: number;
  refusedFleet: number;
  refusedPaused: number;
  activeInstallations: number;
  registrations: number;
  registrationsRefused: number;
  appEvents: number;
}

type Row = Record<string, number | string | null>;

/** The month's Composio bill under the price settings: the plan, plus what the included quotas do not cover, less the
 *  plan's usage credit. */
export function costEstimate(values: Readonly<Record<NumberSetting, number>>, toolCalls: number, appEvents: number) {
  const over = (used: number, included: number, per1k: number) => Math.max(0, used - included) * per1k / 1000;
  const usage = over(toolCalls, values["price.tool_calls_included"], values["price.usd_per_1k_tool_calls"])
    + over(appEvents, values["price.trigger_events_included"], values["price.usd_per_1k_trigger_events"]);
  return Math.round((values["price.plan_usd"] + Math.max(0, usage - values["price.credit_usd"])) * 100) / 100;
}

function emptyDay(day: string): DayCounts {
  return { day, toolCalls: 0, connectLinks: 0, refusedQuota: 0, refusedFleet: 0, refusedPaused: 0, activeInstallations: 0, registrations: 0, registrationsRefused: 0, appEvents: 0 };
}

/** Fleet counts for each UTC day from `from` to `to` that has any. Counts only, never an installation id. */
async function dailyCounts(env: Env, from: string, to: string): Promise<DayCounts[]> {
  const [usage, registrations, events] = await Promise.all([
    env.DB.prepare(
      `SELECT day, SUM(tool_calls) AS tool_calls, SUM(connect_links) AS connect_links, SUM(refused_quota) AS refused_quota,
         SUM(refused_fleet) AS refused_fleet, SUM(refused_paused) AS refused_paused,
         COUNT(CASE WHEN installation_id != '' AND tool_calls > 0 THEN 1 END) AS active_installations
       FROM usage_days WHERE day BETWEEN ?1 AND ?2 GROUP BY day`,
    ).bind(from, to).all<Row>(),
    env.DB.prepare(
      "SELECT day, SUM(registrations) AS registrations, SUM(refused) AS refused FROM registration_days WHERE day BETWEEN ?1 AND ?2 GROUP BY day",
    ).bind(from, to).all<Row>(),
    env.DB.prepare(`SELECT day, SUM(${BILLED_EVENTS}) AS app_events FROM app_event_days WHERE day BETWEEN ?1 AND ?2 GROUP BY day`)
      .bind(from, to).all<Row>(),
  ]);
  const days = new Map<string, DayCounts>();
  const at = (day: string) => {
    let counts = days.get(day);
    if (!counts) days.set(day, counts = emptyDay(day));
    return counts;
  };
  const count = (value: unknown) => Number(value ?? 0) || 0;
  for (const row of usage.results) {
    Object.assign(at(String(row.day)), {
      toolCalls: count(row.tool_calls),
      connectLinks: count(row.connect_links),
      refusedQuota: count(row.refused_quota),
      refusedFleet: count(row.refused_fleet),
      refusedPaused: count(row.refused_paused),
      activeInstallations: count(row.active_installations),
    });
  }
  for (const row of registrations.results) {
    Object.assign(at(String(row.day)), { registrations: count(row.registrations), registrationsRefused: count(row.refused) });
  }
  for (const row of events.results) at(String(row.day)).appEvents = count(row.app_events);
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

async function monthToDate(env: Env, now: number) {
  const from = `${utcDay(now).slice(0, 7)}-01`;
  const row = await env.DB.prepare(
    `SELECT (SELECT COALESCE(SUM(tool_calls), 0) FROM usage_days WHERE day >= ?1) AS tool_calls,
       (SELECT COALESCE(SUM(${BILLED_EVENTS}), 0) FROM app_event_days WHERE day >= ?1) AS app_events`,
  ).bind(from).first<{ tool_calls: number; app_events: number }>();
  return { from, toolCalls: Number(row?.tool_calls ?? 0), appEvents: Number(row?.app_events ?? 0) };
}

/** GET /v1/stats/usage?days=<1-90>, Bearer STATS_TOKEN: the fleet's daily usage, the month so far and its estimated
 *  Composio bill, and the limits in force. Counts only. */
export async function usageStats(request: Request, url: URL, env: Env) {
  if (!env.STATS_TOKEN) return json({ error: "not found" }, 404);
  const presented = request.headers.get("authorization")?.match(/^Bearer (\S{1,512})$/)?.[1] ?? "";
  if (!sameDigest(await sha256(presented), await sha256(env.STATS_TOKEN))) return json({ error: "unauthorized" }, 401);
  const days = intParam(url, "days", 30, RETENTION_DAYS);
  if (!days) return json({ error: "days must be 1-90" }, 400);
  const now = Date.now();
  const settings = await limitSettings(env);
  const month = await monthToDate(env, now);
  return json({
    days: await dailyCounts(env, utcDay(now - (days - 1) * DAY_MS), utcDay(now)),
    month: { ...month, estimateUsd: costEstimate(settings.values, month.toolCalls, month.appEvents) },
    pause: settings.pause,
    dailySummary: settings.dailySummary,
    workbench: settings.workbench,
    settings: settings.values,
  });
}

/** Posts one alert. Telegram gets {chat_id, text}, Discord {content}, any other https webhook (Slack, say) {text}.
 *  True once the alert needs no retry. The webhook URL holds a secret, so no log line names it. */
async function sendAlert(env: Env, text: string) {
  if (!env.ALERT_WEBHOOK_URL) {
    console.warn(JSON.stringify({ message: "usage alert", text }));
    return true;
  }
  let target: URL | undefined;
  try {
    target = new URL(env.ALERT_WEBHOOK_URL);
  } catch {
    target = undefined;
  }
  if (target?.protocol !== "https:") {
    console.error(JSON.stringify({ message: "usage alert not sent: ALERT_WEBHOOK_URL is not an https URL", text }));
    return true;
  }
  const host = target.hostname;
  const body = host === "api.telegram.org" ? { chat_id: env.ALERT_CHAT_ID, text }
    : host === "discord.com" || host === "discordapp.com" || host.endsWith(".discord.com") ? { content: text }
    : { text };
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (response.ok) return true;
    console.error(JSON.stringify({ message: "usage alert failed", status: response.status }));
  } catch (error) {
    console.error(JSON.stringify({ message: "usage alert failed", error: error instanceof Error ? error.name : "unknown" }));
  }
  return false;
}

const usd = (value: number) => `$${value.toFixed(2)}`;

/** The hourly cost watch: sends each alert kind at most once per UTC day, the day before's summary once, and keeps 90
 *  days of counts. Never throws, so the rest of the hourly work still runs. */
export async function watchUsage(env: Env, now = Date.now()) {
  try {
    const settings = await limitSettings(env);
    const values = settings.values;
    const today = utcDay(now);
    const sent = new Set((await env.DB.prepare("SELECT kind FROM usage_alerts WHERE day = ?").bind(today).all<{ kind: string }>())
      .results.map(({ kind }) => kind));
    const [counts] = await dailyCounts(env, today, today);
    const used = counts?.toolCalls ?? 0;
    const month = await monthToDate(env, now);
    const estimate = costEstimate(values, month.toolCalls, month.appEvents);
    const alerts: Array<[kind: string, text: () => Promise<string> | string]> = [];

    const budget = values["budget.tool_calls_per_day"];
    const ratio = values["alert.budget_ratio"];
    if (budget > 0 && used >= budget) {
      alerts.push(["budget-reached", () => `Seira connected apps: daily tool-call budget reached (${used} of ${budget}). New tool calls stop until 00:00 UTC.`]);
    } else if (budget > 0 && ratio > 0 && used >= budget * ratio) {
      alerts.push(["budget-near", () => `Seira connected apps: ${used} of ${budget} tool calls used today (${Math.floor((used / budget) * 100)}%). At ${budget}, new tool calls stop until 00:00 UTC.`]);
    }
    if (settings.pause !== "none") {
      alerts.push(["paused", () => `Seira connected apps: pause is "${settings.pause}". Set the pause setting to "none" to resume.`]);
    }
    const costLimit = values["alert.usd_per_month"];
    if (costLimit > 0 && estimate >= costLimit) {
      alerts.push(["month-cost", () => `Seira connected apps: the estimated Composio bill for this month is ${usd(estimate)} (alert at ${usd(costLimit)}). Since ${month.from}: ${month.toolCalls} tool calls, ${month.appEvents} trigger events.`]);
    }
    const registrationLimit = values["alert.registrations_per_day"];
    if (registrationLimit > 0 && (counts?.registrations ?? 0) >= registrationLimit) {
      alerts.push(["registrations", () => `Seira connected apps: ${counts!.registrations} new installations today (alert at ${registrationLimit}), ${counts!.registrationsRefused} refused.`]);
    }
    if (settings.dailySummary) {
      alerts.push(["daily-summary", async () => {
        const day = utcDay(now - DAY_MS);
        const c = (await dailyCounts(env, day, day))[0] ?? emptyDay(day);
        return `Seira connected apps, ${day}: ${c.toolCalls} tool calls by ${c.activeInstallations} installations, ${c.connectLinks} sign-in links, `
          + `${c.appEvents} trigger events, ${c.registrations} new installations. Refused: ${c.refusedQuota} over a device limit, `
          + `${c.refusedFleet} over the daily budget, ${c.refusedPaused} while paused. This month: ${month.toolCalls} tool calls, `
          + `${month.appEvents} trigger events, estimate ${usd(estimate)}.`;
      }]);
    }

    for (const [kind, text] of alerts) {
      if (sent.has(kind) || !(await sendAlert(env, await text()))) continue;
      await env.DB.prepare("INSERT OR IGNORE INTO usage_alerts (day, kind, sent_at) VALUES (?, ?, ?)").bind(today, kind, now).run();
    }

    const cutoff = utcDay(now - RETENTION_DAYS * DAY_MS);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM usage_days WHERE day < ?").bind(cutoff),
      env.DB.prepare("DELETE FROM registration_days WHERE day < ?").bind(cutoff),
      env.DB.prepare("DELETE FROM usage_alerts WHERE day < ?").bind(cutoff),
    ]);
  } catch (error) {
    console.error(JSON.stringify({ message: "usage watch failed", error: error instanceof Error ? error.message : String(error) }));
  }
}
