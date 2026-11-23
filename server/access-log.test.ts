import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { accessLogEnabled, formatAccessLine, loggablePath, withAccessLog } from "./access-log.ts";

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

  it("keeps a path on one line and hides a webhook secret", () => {
    expect(loggablePath("/a\r\nforged line?x=1")).not.toMatch(/[\r\n ]/);
    expect(loggablePath("/hooks/wh_abc/topsecret?x=1")).toBe("/hooks/wh_abc/<redacted>");
    expect(loggablePath(undefined)).toBe("/");
    expect(loggablePath(`/${"a".repeat(500)}`).length).toBeLessThan(210);
  });
});
