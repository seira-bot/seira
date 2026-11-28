import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { accessLogEnabled, formatAccessLine, loggablePath, withAccessLog } from "./access-log.ts";
import { ROUTE_TEMPLATES } from "./access-log-routes.ts";

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function get(env: NodeJS.ProcessEnv, path: string, headers: Record<string, string> = {}, status = 200) {
  const lines: string[] = [];
  server = createServer(withAccessLog((_req, res) => { res.statusCode = status; res.end("body-text"); }, "local", env, (line) => lines.push(line)));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => { res.resume(); res.on("end", resolve); });
    req.on("error", reject);
    req.end();
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return lines;
}

describe("access log (FR-373)", () => {
  it("writes nothing when SEIRA_ACCESS_LOG is not 1", async () => {
    expect(accessLogEnabled({})).toBe(false);
    expect(accessLogEnabled({ SEIRA_ACCESS_LOG: "0" })).toBe(false);
    expect(await get({}, "/api/health")).toEqual([]);
  });

  it("writes one line with time, method, path, status and duration for each request", async () => {
    const lines = await get({ SEIRA_ACCESS_LOG: "1" }, "/api/health", {}, 404);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^access \d{4}-\d{2}-\d{2}T[\d:.]+Z GET \/api\/health 404 \d+ms via=local$/);
  });

  it("never writes the query string, a cookie, a header or a body", async () => {
    const lines = await get({ SEIRA_ACCESS_LOG: "1" }, "/pair?token=secret-value&code=pair-code-1", { cookie: "session=cookie-secret", authorization: "Bearer bearer-secret", "x-seira-key": "header-secret" });
    expect(lines).toHaveLength(1);
    for (const secret of ["secret-value", "pair-code-1", "cookie-secret", "bearer-secret", "header-secret", "body-text", "token=", "?"]) expect(lines[0]).not.toContain(secret);
    expect(lines[0]).toContain(" /pair ");
  });

  it("writes the duration as a whole number of milliseconds", () => {
    const line = formatAccessLine({ time: new Date(0), method: "POST", path: "/x", status: 201, durationMs: 12.6, route: "tunnel" });
    expect(line).toBe("access 1970-01-01T00:00:00.000Z POST /x 201 13ms via=tunnel");
    expect(Number(/ (\d+)ms /.exec(line)?.[1])).toBe(13);
  });

  it("keeps a path on one line and hides a webhook path", () => {
    expect(loggablePath("/a\r\nforged line?x=1")).not.toMatch(/[\r\n ]/);
    expect(loggablePath("/api/\r\nforged line")).not.toMatch(/[\r\n ]/);
    expect(loggablePath("/hooks/wh_abc/topsecret?x=1")).toBe("/hooks/:id/<redacted>");
    expect(loggablePath(undefined)).toBe("/");
    expect(loggablePath(`/api/${"bots/".repeat(100)}`).length).toBeLessThan(210);
  });

  it("writes the shape of a known route and :id for each name or id", () => {
    expect(loggablePath("/api/health")).toBe("/api/health");
    expect(loggablePath("/api/bots/3f2a9c1e-77aa-4b21-9d0e-5c6f1a2b3c4d")).toBe("/api/bots/:id");
    expect(loggablePath("/api/bots/3f2a9c1e/messages")).toBe("/api/bots/:id/messages");
    expect(loggablePath("/api/bots/3f2a9c1e/computer")).toBe("/api/bots/:id/computer");
    expect(loggablePath("/api/bots/")).toBe("/api/bots");
    expect(loggablePath("/pair?x=1#y")).toBe("/pair");
    expect(loggablePath("/")).toBe("/");
  });

  it("writes each template of the route list as itself or with :id for a word that some route reads as a name", () => {
    expect(ROUTE_TEMPLATES.length).toBeGreaterThan(100);
    let same = 0;
    for (const template of ROUTE_TEMPLATES) {
      const concrete = template.replaceAll(":id", "Zk3-9fQ2vL0aXb7");
      const written = loggablePath(concrete);
      expect(written, concrete).not.toContain("Zk3-9fQ2vL0aXb7");
      const want = template.split("/");
      const got = written.split("/");
      expect(got, concrete).toHaveLength(want.length);
      got.forEach((part, i) => expect([want[i], ":id"], concrete).toContain(part));
      if (written === template) same += 1;
    }
    expect(same).toBeGreaterThan(ROUTE_TEMPLATES.length / 2);
  });

  it("writes :id for a word when another known route reads the same position as a name or an id", () => {
    expect(ROUTE_TEMPLATES).toContain("/api/connectors/:id");
    expect(ROUTE_TEMPLATES).toContain("/api/connectors/catalog");
    expect(loggablePath("/api/connectors/catalog")).toBe("/api/connectors/:id");
    expect(loggablePath("/api/connectors/Zk3-9fQ2vL0aXb7")).toBe("/api/connectors/:id");
    expect(loggablePath("/api/bots/3f2a9c1e/messages/guarded")).toBe("/api/bots/:id/messages/:id");
    expect(loggablePath("/api/bots/3f2a9c1e/messages/abc123def456/edit")).toBe("/api/bots/:id/messages/:id/edit");
    expect(loggablePath("/api/bots/order")).toBe("/api/bots/:id");
    expect(loggablePath("/api/bots/order/messages")).toBe("/api/bots/:id/messages");
  });

  it("keeps a word that no known route reads as a name or an id", () => {
    expect(loggablePath("/api/health")).toBe("/api/health");
    expect(loggablePath("/mcp-oauth/callback")).toBe("/mcp-oauth/callback");
    expect(loggablePath("/api/bots/abc123def456/computer")).toBe("/api/bots/:id/computer");
  });

  it("takes a fixed word for a name in a variable position", () => {
    expect(loggablePath("/api/bots/messages")).toBe("/api/bots/:id");
    expect(loggablePath("/api/bots/messages/messages")).toBe("/api/bots/:id/messages");
    expect(loggablePath("/api/bots/connectors/computer")).toBe("/api/bots/:id/computer");
    expect(loggablePath("/api/bots/bots/bots")).toBe("/api/bots/:id/<other>");
  });

  it("takes a name for a fixed word in a fixed position", () => {
    expect(loggablePath("/api/Zk3-9fQ2vL0aXb7")).toBe("/api/<other>");
    expect(loggablePath("/api/bots/abc123def456/Zk3-9fQ2vL0aXb7")).toBe("/api/bots/:id/<other>");
    expect(loggablePath("/api/bots/abc123def456/messages/Zk3-9fQ2vL0aXb7/more")).toBe("/api/bots/:id/messages/:id/<other>");
    expect(loggablePath("/api/health/Zk3-9fQ2vL0aXb7/more")).toBe("/api/health/<other>");
    expect(loggablePath("/api/bots/abc123def456/computer")).toBe("/api/bots/:id/computer");
  });

  it("never writes a segment that is not a fixed route word in its position", () => {
    const odd = ["Zk3-9fQ2vL0aXb7", "abc123def456", "user.name", "%2e%2e", "xyz", "%0d%0a"];
    for (const segment of odd) {
      for (const path of [`/api/bots/${segment}`, `/api/${segment}`, `/api/bots/${segment}/files/${segment}`, `/api/bots/${segment}/${segment}`, `/mcp-oauth/${segment}`, `/hooks/${segment}`]) {
        expect(loggablePath(path), path).not.toContain(segment);
      }
    }
  });

  it("writes <other> for a path outside the known routes, and no part of it", () => {
    expect(loggablePath("/unknown-area/Zk3-9fQ2vL0aXb7")).toBe("<other>");
    expect(loggablePath("/Zk3-9fQ2vL0aXb7")).toBe("<other>");
    expect(loggablePath("*")).toBe("<other>");
    expect(loggablePath("http://host.example/api/bots")).toBe("<other>");
  });

  it("keeps a path with an id out of the written line", async () => {
    const lines = await get({ SEIRA_ACCESS_LOG: "1" }, "/api/bots/Zk3-9fQ2vL0aXb7/threads/abc123def456?x=1");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(" GET /api/bots/:id/threads/<other> 200 ");
    expect(lines[0]).not.toContain("Zk3-9fQ2vL0aXb7");
    expect(lines[0]).not.toContain("abc123def456");
  });
});
