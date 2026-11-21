import type { VisibleSet } from "../bot-visibility.ts";
import type { RequestAuth } from "../request-auth.ts";
import { workRows, type WorkRow } from "../message-db.ts";
import { isConnectedAppsServer } from "../../shared/own-apps.ts";
import { toolApps } from "../../shared/today-outcomes.ts";
import { PASS, type RouteHandler } from "./table.ts";

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface AppUsageRouteDeps {
  visibleFor: (auth: RequestAuth) => Pick<VisibleSet, "thread">;
  rows?: (since: number, until: number) => WorkRow[];
  now?: () => number;
}

function ownServerTool(name: string): boolean {
  if (!name.startsWith("mcp__")) return false;
  return !isConnectedAppsServer(name.split("__")[1] ?? "");
}

/** Composio apps that tool calls ran, with the number of calls, most calls first. */
export function appUsage(rows: readonly WorkRow[], visible: (threadId: string) => boolean): Array<{ app: string; calls: number }> {
  const calls = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "activity" || !row.name || ownServerTool(row.name) || !visible(row.threadId)) continue;
    for (const app of toolApps(row.name, row.input ?? undefined)) calls.set(app, (calls.get(app) ?? 0) + 1);
  }
  return [...calls].map(([app, count]) => ({ app, calls: count })).sort((a, b) => b.calls - a.calls || a.app.localeCompare(b.app));
}

/** GET /api/apps/usage: the Composio apps this server's bots called in the last 7 days. */
export function createAppUsageRoutes(deps: AppUsageRouteDeps): RouteHandler {
  return async ({ res, path, method, auth, json }) => {
    if (path !== "/api/apps/usage") return PASS;
    if (method !== "GET") return json(res, 405, { error: "method not allowed" });
    const now = deps.now?.() ?? Date.now();
    const since = now - WINDOW_MS;
    const visible = deps.visibleFor(auth);
    return json(res, 200, { since, apps: appUsage((deps.rows ?? workRows)(since, now), (threadId) => visible.thread(threadId)) });
  };
}
