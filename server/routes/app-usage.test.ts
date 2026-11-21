import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { WorkRow } from "../message-db.ts";
import type { RequestAuth } from "../request-auth.ts";
import { appUsage, createAppUsageRoutes } from "./app-usage.ts";
import { PASS, type RouteContext } from "./table.ts";

const row = (name: string | null, threadId = "t1", extra: Partial<WorkRow> = {}): WorkRow => ({
  threadId, id: `${name}-${threadId}-${Math.random()}`, at: 1, kind: "activity", name, ok: 1, turnId: null, fromBotId: null,
  turnSucceeded: null, requestMessageId: null, digest: null, input: null, ...extra,
});
const all = () => true;

describe("appUsage", () => {
  it("counts one call per app and ranks the most calls first, then by name", () => {
    const rows = [row("mcp__composio__GMAIL_SEND_EMAIL"), row("GMAIL_FETCH_EMAILS"), row("mcp__composio__SLACK_SEND_MESSAGE"), row("GITHUB_CREATE_ISSUE")];
    expect(appUsage(rows, all)).toEqual([{ app: "GMAIL", calls: 2 }, { app: "GITHUB", calls: 1 }, { app: "SLACK", calls: 1 }]);
  });
  it("counts each app that one multi-execute call ran", () => {
    const input = JSON.stringify({ tools: [{ tool_slug: "SLACK_SEND_MESSAGE", arguments: {} }, { tool_slug: "HUBSPOT_CREATE_CONTACT", arguments: {} }] });
    expect(appUsage([row("COMPOSIO_MULTI_EXECUTE_TOOL", "t1", { input })], all)).toEqual([{ app: "HUBSPOT", calls: 1 }, { app: "SLACK", calls: 1 }]);
  });
  it("leaves out a conversation the viewer cannot see", () => {
    const rows = [row("GMAIL_SEND_EMAIL", "hidden"), row("SLACK_SEND_MESSAGE", "seen")];
    expect(appUsage(rows, (threadId) => threadId === "seen")).toEqual([{ app: "SLACK", calls: 1 }]);
  });
  it("leaves out a server that the person added", () => {
    expect(appUsage([row("mcp__my_docs__SEARCH_PAGES"), row("mcp__claude_ai_Gmail__search_threads")], all)).toEqual([]);
  });
  it("ignores digest rows, rows with no name and tools that are not apps", () => {
    expect(appUsage([row("GMAIL_SEND_EMAIL", "t1", { kind: "digest" }), row(null), row("Bash")], all)).toEqual([]);
  });
});

describe("GET /api/apps/usage", () => {
  const NOW = 10 * 24 * 60 * 60 * 1000;
  const call = async (method: string, path: string, seen: string[] = ["t1"]) => {
    const asked: Array<[number, number]> = [];
    const route = createAppUsageRoutes({
      visibleFor: () => ({ thread: (id: string) => seen.includes(id) }),
      rows: (since, until) => { asked.push([since, until]); return [row("GMAIL_SEND_EMAIL"), row("GMAIL_SEND_EMAIL", "t2")]; },
      now: () => NOW,
    });
    const sent: { status?: number; body?: any } = {};
    const out = await route({
      req: {} as IncomingMessage, res: {} as ServerResponse, url: new URL(path, "http://127.0.0.1"), path, method,
      auth: { kind: "loopback", scopes: ["client"] } as RequestAuth, readBody: (async () => ({})) as RouteContext["readBody"],
      json: ((_res: ServerResponse, status: number, body: unknown) => { sent.status = status; sent.body = body; }) as RouteContext["json"],
    });
    return { out, asked, ...sent };
  };
  it("answers with the apps of the last 7 days", async () => {
    const answer = await call("GET", "/api/apps/usage");
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ since: NOW - 7 * 24 * 60 * 60 * 1000, apps: [{ app: "GMAIL", calls: 1 }] });
    expect(answer.asked).toEqual([[NOW - 7 * 24 * 60 * 60 * 1000, NOW]]);
  });
  it("refuses other methods", async () => {
    expect((await call("POST", "/api/apps/usage")).status).toBe(405);
  });
  it("passes other paths on", async () => {
    expect((await call("GET", "/api/today")).out).toBe(PASS);
  });
});
