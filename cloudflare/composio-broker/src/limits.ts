import { DAY_MS, json, sha256, utcDay, utf8, type InstallationRow } from "./common";

/** Owner decisions (FR-147..149), each one changeable in the broker_settings table without a redeploy. 0 turns a
 *  limit or an alert off; `units.workbench` is at least 1. The prices are Composio Pro's for its own OAuth apps at the Gmail tier
 *  (https://composio.dev/pricing/platform, 2026-11-19): the costliest common case, so the estimate errs high. */
export const NUMBER_SETTINGS = {
  "quota.tool_calls.desktop": 500,
  "quota.tool_calls.cloud": 2_000,
  "quota.connect_links": 30,
  "quota.triggers": 50,
  "quota.registrations_per_ip": 50,
  "budget.tool_calls_per_day": 10_000,
  "units.workbench": 10,
  "alert.budget_ratio": 0.8,
  "alert.usd_per_month": 50,
  "alert.registrations_per_day": 1_000,
  "price.plan_usd": 29,
  "price.credit_usd": 29,
  "price.tool_calls_included": 20_000,
  "price.usd_per_1k_tool_calls": 2,
  "price.trigger_events_included": 10_000,
  "price.usd_per_1k_trigger_events": 6,
} as const;
export type NumberSetting = keyof typeof NUMBER_SETTINGS;

/** The kill switch. new: no new installations, sign-in links, or triggers. tools: new, plus no billable tool calls.
 *  all: tools, plus no route that reaches Composio, except the ones that remove data. */
export const PAUSE_LEVELS = ["none", "new", "tools", "all"] as const;
export type PauseLevel = (typeof PAUSE_LEVELS)[number];

export interface LimitSettings {
  pause: PauseLevel;
  dailySummary: boolean;
  /** Off: the shared key refuses the remote workbench and bash meta tools. */
  workbench: boolean;
  values: Record<NumberSetting, number>;
}

/** Metered by installation; a Cloud installation has the Cloud quota once an Admin grant names it. */
type Metered = Pick<InstallationRow, "id"> & { cloud_machine_id?: string | null };
type RefusalColumn = "refused_quota" | "refused_fleet" | "refused_paused";

const SETTINGS_TTL_MS = 30_000;
const FLEET_TTL_MS = 60_000;
/** Binds as "no limit" where a setting is 0. */
const UNLIMITED = Number.MAX_SAFE_INTEGER;
const FREE_TOOLS = new Set(["COMPOSIO_SEARCH_TOOLS"]);
const MULTI_EXECUTE = "COMPOSIO_MULTI_EXECUTE_TOOL";
/** Run code at Composio that can call many tools in one call, which the broker cannot see. Each call counts as
 *  `units.workbench` tool calls. */
const WORKBENCH_TOOLS = new Set(["COMPOSIO_REMOTE_WORKBENCH", "COMPOSIO_REMOTE_BASH_TOOL"]);
/** Starts app sign-ins from the relay, so the pause stops it like the sign-in link route. */
const MANAGE_CONNECTIONS = "COMPOSIO_MANAGE_CONNECTIONS";
/** Multi-execute calls nested deeper than this are refused: the broker does not count what it does not read. */
const NESTED_LIMIT = 3;
const TOO_DEEP = "\u0000nested";
const CONNECT_LINK = /^\/v1\/connectors\/[^/]+\/authorize$/;
const KEY_PLACE = "Settings → AI → Other services";

const REFUSED = {
  quota: `This app action did not run: this device used all of today's app actions. They start again at 00:00 UTC. To keep going now, add your own Composio project key in ${KEY_PLACE}.`,
  fleet: `This app action did not run: Seira's shared connected apps used all of today's app actions. Try again after 00:00 UTC, or add your own Composio project key in ${KEY_PLACE}.`,
  paused: `This app action did not run: Seira's shared connected apps are paused for a short time. Try again later, or add your own Composio project key in ${KEY_PLACE}.`,
  nested: "This app action did not run: it puts multi-execute calls more than three levels deep. Run the tools in fewer levels.",
  workbench: `This app action did not run: Seira's shared connected apps do not run code in the remote workbench. Use the app tools directly, or add your own Composio project key in ${KEY_PLACE}.`,
  route: "Connected apps are paused for a short time. Try again later.",
  links: "You started many app sign-ins today. Try again tomorrow.",
  triggers: "This device has the most app triggers it can have. Remove a trigger to add a new one.",
};

const RESERVE_TOOL_CALLS = `INSERT INTO usage_days (day, installation_id, tool_calls) VALUES (?1, ?2, ?3)
  ON CONFLICT (day, installation_id) DO UPDATE SET tool_calls = usage_days.tool_calls + excluded.tool_calls
  WHERE usage_days.tool_calls + excluded.tool_calls <= ?4`;
const RESERVE_LINK = `INSERT INTO usage_days (day, installation_id, connect_links) VALUES (?1, ?2, 1)
  ON CONFLICT (day, installation_id) DO UPDATE SET connect_links = usage_days.connect_links + 1
  WHERE usage_days.connect_links < ?3`;
const COUNT_REGISTRATION = `INSERT INTO registration_days (day, source, registrations) VALUES (?1, ?2, 1)
  ON CONFLICT (day, source) DO UPDATE SET registrations = registration_days.registrations + 1
  WHERE registration_days.registrations < ?3`;
const USAGE_COLUMNS = ["tool_calls", "connect_links", "refused_quota", "refused_fleet", "refused_paused"] as const;

let cachedSettings: { at: number; settings: LimitSettings } | undefined;
/** This isolate's view of the fleet's tool calls today: read from D1 once a minute, plus what it admitted since. */
let fleet: { day: string; at: number; used: number } | undefined;

export function forgetLimitSettings() {
  cachedSettings = undefined;
  fleet = undefined;
}

function logFailure(error: unknown) {
  console.error(JSON.stringify({ message: "usage limits unavailable", error: error instanceof Error ? error.message : String(error) }));
}

function parseSettings(rows: Array<{ key: string; value: string }>): LimitSettings {
  const settings: LimitSettings = { pause: "none", dailySummary: true, workbench: true, values: { ...NUMBER_SETTINGS } };
  for (const { key, value } of rows) {
    const text = String(value).trim();
    if (key === "pause" && (PAUSE_LEVELS as readonly string[]).includes(text)) settings.pause = text as PauseLevel;
    else if (key === "alert.daily_summary" && (text === "on" || text === "off")) settings.dailySummary = text === "on";
    else if (key === "tools.workbench" && (text === "on" || text === "off")) settings.workbench = text === "on";
    else if (Object.hasOwn(NUMBER_SETTINGS, key) && /^\d{1,15}(\.\d{1,6})?$/.test(text)) settings.values[key as NumberSetting] = Number(text);
    else console.error(JSON.stringify({ message: "broker setting ignored, default used", key: String(key).slice(0, 64) }));
  }
  return settings;
}

/** The broker_settings rows over the defaults, read at most every 30 seconds per isolate. Never throws: without the
 *  table (migration 0007 not applied yet), the defaults. */
export async function limitSettings(env: Env): Promise<LimitSettings> {
  const now = Date.now();
  if (cachedSettings && now >= cachedSettings.at && now - cachedSettings.at < SETTINGS_TTL_MS) return cachedSettings.settings;
  let settings: LimitSettings;
  try {
    const { results } = await env.DB.prepare("SELECT key, value FROM broker_settings").all<{ key: string; value: string }>();
    settings = parseSettings(results ?? []);
  } catch (error) {
    logFailure(error);
    settings = parseSettings([]);
  }
  cachedSettings = { at: now, settings };
  return settings;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The slugs a multi-execute call runs, a nested multi-execute item by its own items. "" is a billable tool: an item
 *  without a slug or with a free slug, and a call with no items. */
function multiExecuteNames(args: unknown, depth: number): string[] {
  const tools = record(args)?.tools;
  if (!Array.isArray(tools) || !tools.length) return [""];
  return tools.flatMap((item) => {
    const entry = record(item);
    const slug = typeof entry?.tool_slug === "string" ? entry.tool_slug.toUpperCase() : "";
    if (slug === MULTI_EXECUTE) return depth < NESTED_LIMIT ? multiExecuteNames(entry?.arguments, depth + 1) : [TOO_DEEP];
    return [FREE_TOOLS.has(slug) ? "" : slug];
  });
}

/** The tool names one MCP message runs, upper case: a tools/call its name, a multi-execute call the slug of each tool
 *  it runs, and a JSON-RPC batch each item's. */
function toolNames(message: unknown): string[] {
  if (Array.isArray(message)) return message.flatMap(toolNames);
  const rpc = record(message);
  if (rpc?.method !== "tools/call") return [];
  const params = record(rpc.params);
  const name = typeof params?.name === "string" ? params.name.toUpperCase() : "";
  return name === MULTI_EXECUTE ? multiExecuteNames(params?.arguments, 1) : [name];
}

/** Billable Composio tool executions in one MCP message: each tool it runs is 1, the free search meta tool 0, and a
 *  workbench or bash meta tool `workbench` units. */
export function toolUnits(message: unknown, workbench: number = NUMBER_SETTINGS["units.workbench"]): number {
  return unitsOf(toolNames(message), workbench);
}

function unitsOf(names: string[], workbench: number) {
  return names.reduce((sum, name) => sum + (FREE_TOOLS.has(name) ? 0 : WORKBENCH_TOOLS.has(name) ? Math.max(1, workbench) : 1), 0);
}

/** The rate-limit key of an address: an IPv4 address whole (also when IPv4-mapped), an IPv6 address by its /64. */
export function addressKey(address: string) {
  const ip = address.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) return mapped[1]!;
  if (!ip.includes(":")) return ip;
  const [head = "", tail] = ip.split("%")[0]!.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = tail === undefined ? front : [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
  return `${groups.slice(0, 4).map((group) => (Number.parseInt(group, 16) || 0).toString(16)).join(":")}::/64`;
}

async function countRefusal(env: Env, installationId: string, column: RefusalColumn) {
  try {
    await env.DB.prepare(
      `INSERT INTO usage_days (day, installation_id, ${column}) VALUES (?1, ?2, 1)
       ON CONFLICT (day, installation_id) DO UPDATE SET ${column} = usage_days.${column} + 1`,
    ).bind(utcDay(Date.now()), installationId).run();
  } catch (error) {
    logFailure(error);
  }
}

/** A JSON-RPC tool error for each request in the message, so the model reads why the action did not run. */
function rpcRefusal(message: unknown, text: string) {
  const reply = (item: unknown) => ({ jsonrpc: "2.0", id: record(item)?.id ?? null, result: { content: [{ type: "text", text }], isError: true } });
  return json(Array.isArray(message) ? message.filter((item) => record(item)?.id !== undefined).map(reply) : reply(message));
}

async function fleetUsed(env: Env, day: string) {
  const now = Date.now();
  if (fleet?.day === day && now >= fleet.at && now - fleet.at < FLEET_TTL_MS) return fleet.used;
  const row = await env.DB.prepare("SELECT COALESCE(SUM(tool_calls), 0) AS used FROM usage_days WHERE day = ?").bind(day).first<{ used: number }>();
  fleet = { day, at: now, used: Number(row?.used ?? 0) || 0 };
  return fleet.used;
}

/** Checks one MCP request body against the pause level, the fleet budget, and the installation's daily quota, and
 *  reserves its units. Returns the bytes to forward, or the Response to send instead. The bytes are the JSON value
 *  this function counted, written again: Composio parses what it receives, so a duplicate key or an odd number form
 *  cannot make a counted-free message billable. */
export async function admitMcp(raw: Uint8Array, installation: Metered, env: Env): Promise<Uint8Array<ArrayBuffer> | Response> {
  let message: unknown;
  try {
    message = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  const forward = utf8(JSON.stringify(message));
  const names = toolNames(message);
  if (!names.some((name) => !FREE_TOOLS.has(name))) return forward;
  // Before the settings and the quota: this refusal holds with every limit off and without D1.
  if (names.includes(TOO_DEEP)) {
    await countRefusal(env, installation.id, "refused_quota");
    return rpcRefusal(message, REFUSED.nested);
  }
  const settings = await limitSettings(env);
  const units = unitsOf(names, settings.values["units.workbench"]);
  // Under "new", also the meta tools that start sign-ins: the workbench can run them where the broker cannot see.
  const startsSignIn = names.some((name) => name === MANAGE_CONNECTIONS || WORKBENCH_TOOLS.has(name));
  if (settings.pause === "tools" || settings.pause === "all" || (settings.pause === "new" && startsSignIn)) {
    await countRefusal(env, installation.id, "refused_paused");
    return rpcRefusal(message, REFUSED.paused);
  }
  if (!settings.workbench && names.some((name) => WORKBENCH_TOOLS.has(name))) {
    await countRefusal(env, installation.id, "refused_quota");
    return rpcRefusal(message, REFUSED.workbench);
  }
  try {
    const day = utcDay(Date.now());
    const budget = settings.values["budget.tool_calls_per_day"];
    if (budget > 0 && (await fleetUsed(env, day)) + units > budget) {
      await countRefusal(env, installation.id, "refused_fleet");
      return rpcRefusal(message, REFUSED.fleet);
    }
    const quota = settings.values[installation.cloud_machine_id ? "quota.tool_calls.cloud" : "quota.tool_calls.desktop"];
    const reserved = quota > 0 && units > quota ? 0 : (await env.DB.prepare(RESERVE_TOOL_CALLS)
      .bind(day, installation.id, units, quota > 0 ? quota : UNLIMITED).run()).meta.changes;
    if (!reserved) {
      await countRefusal(env, installation.id, "refused_quota");
      return rpcRefusal(message, REFUSED.quota);
    }
    if (fleet?.day === day) fleet.used += units;
  } catch (error) {
    logFailure(error);
  }
  return forward;
}

function reachesComposio(path: string) {
  return path === "/v1/mcp" || path === "/v1/catalog" || path === "/v1/files/upload"
    || path === "/v1/connectors" || path.startsWith("/v1/connectors/")
    || path === "/v1/triggers" || path.startsWith("/v1/triggers/")
    || path === "/v1/trigger-types" || path.startsWith("/v1/trigger-types/");
}

function secondsToNextDay(now: number) {
  return Math.max(1, Math.ceil((Date.parse(`${utcDay(now)}T00:00:00Z`) + DAY_MS - now) / 1000));
}

/** The pause level, the daily sign-in link quota, and the trigger cap, for an authenticated route other than the
 *  relay's tool calls. Reads no request body. Null lets the request through. */
export async function admitRoute(request: Request, url: URL, installation: Metered, env: Env): Promise<Response | null> {
  const { method } = request;
  const path = url.pathname;
  if (!reachesComposio(path)) return null;
  const link = method === "POST" && CONNECT_LINK.test(path);
  const newTrigger = method === "POST" && path === "/v1/triggers";
  const settings = await limitSettings(env);
  const paused = settings.pause === "all" ? method !== "DELETE" : settings.pause !== "none" && (link || newTrigger);
  if (paused) return json({ error: REFUSED.route }, 503, { "retry-after": "300" });
  try {
    if (link) {
      const now = Date.now();
      const limit = settings.values["quota.connect_links"];
      const reserved = await env.DB.prepare(RESERVE_LINK).bind(utcDay(now), installation.id, limit > 0 ? limit : UNLIMITED).run();
      if (reserved.meta.changes) return null;
      await countRefusal(env, installation.id, "refused_quota");
      return json({ error: REFUSED.links }, 429, { "retry-after": String(secondsToNextDay(now)) });
    }
    const cap = settings.values["quota.triggers"];
    if (newTrigger && cap > 0) {
      const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM trigger_bindings WHERE installation_id = ?").bind(installation.id).first<{ n: number }>();
      if (Number(row?.n ?? 0) < cap) return null;
      await countRefusal(env, installation.id, "refused_quota");
      return json({ error: REFUSED.triggers }, 409);
    }
  } catch (error) {
    logFailure(error);
  }
  return null;
}

/** The pause level and the daily registrations per address, before an installation is created. The address is
 *  kept only as a hash with the day in it, so rows of two days do not link. */
export async function admitRegistration(request: Request, env: Env): Promise<Response | null> {
  const settings = await limitSettings(env);
  if (settings.pause !== "none") return json({ error: "registration is temporarily closed" }, 503);
  // Cloudflare sets this on each request it routes; only a local run has none.
  const address = request.headers.get("cf-connecting-ip");
  if (!address) return null;
  const limit = settings.values["quota.registrations_per_ip"];
  try {
    const day = utcDay(Date.now());
    const source = await sha256(`registration|${day}|${addressKey(address)}`);
    const counted = await env.DB.prepare(COUNT_REGISTRATION).bind(day, source, limit > 0 ? limit : UNLIMITED).run();
    if (counted.meta.changes) return null;
    await env.DB.prepare("UPDATE registration_days SET refused = refused + 1 WHERE day = ?1 AND source = ?2").bind(day, source).run();
    return json({ error: "too many registration attempts" }, 429);
  } catch (error) {
    logFailure(error);
    return null;
  }
}

/** Moves an erased installation's daily counts to installation id '', so the fleet totals and the month estimate
 *  stay right. Never throws: an erase does not wait for migration 0007. */
export async function foldUsage(env: Env, installationId: string) {
  if (!installationId) return;
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO usage_days (day, installation_id, ${USAGE_COLUMNS.join(", ")})
         SELECT day, '', ${USAGE_COLUMNS.join(", ")} FROM usage_days WHERE installation_id = ?1
         ON CONFLICT (day, installation_id) DO UPDATE SET ${USAGE_COLUMNS.map((column) => `${column} = usage_days.${column} + excluded.${column}`).join(", ")}`,
      ).bind(installationId),
      env.DB.prepare("DELETE FROM usage_days WHERE installation_id = ?1").bind(installationId),
    ]);
  } catch (error) {
    logFailure(error);
  }
}
