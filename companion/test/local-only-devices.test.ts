import { createServer, get, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import { createConnection } from "node:net";
import { afterEach, expect, it } from "vitest";
import { createProxyHandler } from "../src/proxy.ts";
import type { CompanionEndpoint } from "../src/endpoints.ts";

const servers: Server[] = [];
async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no test port");
  return address.port;
}
afterEach(async () => {
  for (const server of servers.splice(0).reverse()) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const ENDPOINTS: CompanionEndpoint[] = [
  { url: "https://c-0123.example.test", kind: "hosted", priority: 0 },
  { url: "http://192.168.1.5:8810", kind: "lan", priority: 200 },
];

const setup = async (redeemRoutes: "any" | "local" = "any") => {
  const seen: string[] = [];
  const harness = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": open\n\n");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const harnessPort = await listen(harness);
  const routes = { phoneLocal: "local", phoneAny: "any" } as const;
  const proxy = createProxyHandler({
    harnessPort,
    authenticate: (token) => token === "local"
      ? { id: "phoneLocal", routes: "local", cloudDesktopAccess: true, browserControlAccess: false }
      : token === "any"
        ? { id: "phoneAny", routes: "any", cloudDesktopAccess: true, browserControlAccess: false }
        : null,
    deviceRoutes: (id) => routes[id as keyof typeof routes],
    redeem: () => ({ token: "t", device: { id: "new", routes: redeemRoutes } }),
    serverName: () => "Fixture",
    endpoints: () => ENDPOINTS,
  });
  const origin = createServer((req, res) => proxy(req, res, "origin"));
  origin.on("upgrade", (req, socket, head) => proxy.upgrade(req, socket, head, "origin"));
  const lan = createServer((req, res) => proxy(req, res, "lan"));
  lan.on("upgrade", (req, socket, head) => proxy.upgrade(req, socket, head, "lan"));
  return { seen, proxy, originPort: await listen(origin), lanPort: await listen(lan) };
};

const call = (port: number, path: string, token: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });

it("refuses a local-only device on the managed origin", async () => {
  const { seen, originPort, lanPort } = await setup();
  const refused = await call(originPort, "/api/bots", "local");
  expect(refused.status).toBe(403);
  expect(JSON.stringify(await refused.json())).toContain("same Wi-Fi or Tailscale");
  expect(seen).toEqual([]);
  expect((await call(lanPort, "/api/bots", "local")).status).toBe(200);
  expect((await call(originPort, "/api/bots", "any")).status).toBe(200);
  expect(seen).toEqual(["GET /api/bots", "GET /api/bots"]);
});

it("refuses a local-only device upgrade on the managed origin", async () => {
  const { seen, originPort, lanPort } = await setup();
  const upgrade = async (port: number) => {
    const client = createConnection({ host: "127.0.0.1", port });
    let reply = "";
    client.setEncoding("utf8");
    client.on("data", (chunk) => {
      reply += chunk;
    });
    client.once("connect", () => client.write(
      "GET /vps-viewer/abcdefghijklmnopqrstuvwxyz012345/websockify HTTP/1.1\r\n"
        + `Host: 127.0.0.1:${port}\r\nAuthorization: Bearer local\r\n`
        + "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n",
    ));
    await once(client, "close");
    return reply;
  };
  expect(await upgrade(originPort)).toMatch(/^HTTP\/1\.1 403 /);
  expect(await upgrade(lanPort)).toMatch(/^HTTP\/1\.1 404 /);
  expect(seen).toEqual([]);
});

it("leaves the hosted endpoint out for a local-only device", async () => {
  const { lanPort, proxy } = await setup("local");
  const kinds = async (token: string) =>
    ((await (await call(lanPort, "/api/companion/endpoints", token)).json()) as { endpoints: CompanionEndpoint[] }).endpoints.map((e) => e.kind);
  expect(await kinds("local")).toEqual(["lan"]);
  expect(await kinds("any")).toEqual(["hosted", "lan"]);

  const paired = await fetch(`http://127.0.0.1:${lanPort}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "123456", deviceName: "Phone" }),
  });
  const body = (await paired.json()) as { endpoints: CompanionEndpoint[] };
  expect(body.endpoints.map((e) => e.kind)).toEqual(["lan"]);
  expect(proxy.sendEndpoints("phoneLocal")).toBe(0);
});

it("closes the origin streams of a device and keeps its other streams", async () => {
  const { originPort, lanPort, proxy } = await setup();
  const open = (port: number) => new Promise<IncomingMessage>((resolve, reject) => {
    get({ hostname: "127.0.0.1", port, path: "/api/events", headers: { authorization: "Bearer any" } }, resolve).on("error", reject);
  });
  const viaOrigin = await open(originPort);
  const viaLan = await open(lanPort);
  let lanClosed = false;
  viaLan.on("close", () => {
    lanClosed = true;
  });
  viaOrigin.on("error", () => {});
  viaLan.on("error", () => {});
  const originClosed = new Promise<void>((resolve) => viaOrigin.on("close", () => resolve()));
  proxy.disconnectOrigin("phoneAny");
  await originClosed;
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(lanClosed).toBe(false);
  viaLan.destroy();
});
