import { createServer, request, type Server } from "node:http";
import { once } from "node:events";
import { createConnection } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { createProxyHandler } from "../src/proxy.ts";

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

const rawStatus = (port: number, path: string, headers: Record<string, string> = {}) =>
  new Promise<number>((resolve, reject) => {
    const sent = request({ hostname: "127.0.0.1", port, path, headers }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    sent.on("error", reject);
    sent.end();
  });

const sidecar = async (redeemed: unknown[] = []) => {
  const proxy = createProxyHandler({
    harnessPort: 9,
    authenticate: (token) => token === "paired" ? { id: "phone", cloudDesktopAccess: true, browserControlAccess: false } : null,
    redeem: (code, deviceName) => {
      redeemed.push([code, deviceName]);
      return { error: "that pairing credential is not right", code: "pairing_code_wrong" };
    },
    serverName: () => "Fixture",
  });
  const server = createServer(proxy);
  server.on("upgrade", proxy.upgrade);
  return listen(server);
};

it("answers a request target that is not a URL with 400, paired or not", async () => {
  const port = await sidecar();
  expect(await rawStatus(port, "//[")).toBe(400);
  expect(await rawStatus(port, "//[", { authorization: "Bearer paired" })).toBe(400);
  expect(await rawStatus(port, "/vps-viewer/abcdefghijklmnopqrstuvwxyz012345//[", { authorization: "Bearer paired" })).toBe(404);
  expect((await fetch(`http://127.0.0.1:${port}/api/companion/endpoints`, { headers: { authorization: "Bearer paired" } })).status).toBe(200);
});

it("refuses a WebSocket upgrade to a target that is not a URL", async () => {
  const port = await sidecar();
  const client = createConnection({ host: "127.0.0.1", port });
  let response = "";
  client.setEncoding("utf8");
  client.on("data", (chunk) => {
    response += chunk;
  });
  client.once("connect", () => client.write(
    "GET //[ HTTP/1.1\r\n"
      + `Host: 127.0.0.1:${port}\r\n`
      + "Authorization: Bearer paired\r\n"
      + "Connection: Upgrade\r\n"
      + "Upgrade: websocket\r\n"
      + "Sec-WebSocket-Key: dGVzdA==\r\n"
      + "Sec-WebSocket-Version: 13\r\n\r\n",
  ));
  await once(client, "close");
  expect(response).toMatch(/^HTTP\/1\.1 404 /);
});

it("refuses pairing credentials and device names that are not plain values", async () => {
  const redeemed: unknown[] = [];
  const port = await sidecar(redeemed);
  const pair = async (body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    await response.text();
    return response.status;
  };
  expect(await pair({ code: { toString: 0 } })).toBe(400);
  expect(await pair({ credential: ["123456"] })).toBe(400);
  expect(await pair({ code: "123456", deviceName: { toString: 0 } })).toBe(400);
  expect(redeemed).toEqual([]);
  expect(await pair({ code: "123456", deviceName: "Phone" })).toBe(401);
  expect(await pair({ code: 123456 })).toBe(401);
  expect(redeemed).toEqual([["123456", "Phone"], ["123456", undefined]]);
});

it("answers 500 and logs the cause when pairing itself fails", async () => {
  const proxy = createProxyHandler({
    harnessPort: 9,
    authenticate: () => null,
    redeem: () => {
      throw new Error("registry broke");
    },
    serverName: () => "Fixture",
  });
  const port = await listen(createServer(proxy));
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "123456" }),
    });
    expect(response.status).toBe(500);
    expect(logged).toHaveBeenCalledWith("companion: pairing failed", expect.objectContaining({ message: "registry broke" }));
  } finally {
    logged.mockRestore();
  }
});

const fakeHarness = async () => {
  const seen: { method?: string; url?: string; bytes: number }[] = [];
  const server = createServer((req, res) => {
    const entry: { method?: string; url?: string; bytes: number } = { method: req.method, url: req.url, bytes: 0 };
    seen.push(entry);
    req.on("data", (chunk: Buffer) => {
      entry.bytes += chunk.length;
    });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ app: "seira" }));
    });
  });
  return { seen, port: await listen(server) };
};

const proxyToHarness = async (harnessPort: number) => {
  const proxy = createProxyHandler({
    harnessPort,
    authenticate: (token) => token === "paired" ? { id: "phone", cloudDesktopAccess: true, browserControlAccess: false } : null,
    redeem: () => ({ error: "no", code: "pairing_code_wrong" }),
    serverName: () => "Fixture",
  });
  return listen(createServer(proxy));
};

const rawExchange = async (port: number, bytes: string): Promise<string> => {
  const client = createConnection({ host: "127.0.0.1", port });
  let response = "";
  client.setEncoding("utf8");
  client.on("data", (chunk) => {
    response += chunk;
  });
  client.once("connect", () => client.write(bytes));
  const done = once(client, "close");
  setTimeout(() => client.destroy(), 700).unref();
  await done;
  return response;
};

const CHUNKED_SMUGGLE = (method: string, path: string) =>
  `${method} ${path} HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n`
  + "5d\r\nGET /api/bots HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n\r\n0\r\n\r\n";

it.each(["GET", "HEAD", "OPTIONS"])(
  "answers 400 to a %s with Transfer-Encoding and forwards nothing",
  async (method) => {
    const harness = await fakeHarness();
    const port = await proxyToHarness(harness.port);
    const response = await rawExchange(port, CHUNKED_SMUGGLE(method, "/api/health"));
    expect(response).toMatch(/^HTTP\/1\.1 400 /);
    const authed = await rawExchange(port, CHUNKED_SMUGGLE(method, "/api/bots").replace("Host: x", "Host: x\r\nAuthorization: Bearer paired"));
    expect(authed).toMatch(/^HTTP\/1\.1 400 /);
    expect(harness.seen).toEqual([]);
  },
);

it("forwards GET /api/health to the harness as one request with no body", async () => {
  const harness = await fakeHarness();
  const port = await proxyToHarness(harness.port);
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  expect(response.status).toBe(200);
  expect(harness.seen).toEqual([{ method: "GET", url: "/api/health", bytes: 0 }]);
});

it("does not forward the body of a GET that has a Content-Length", async () => {
  const harness = await fakeHarness();
  const port = await proxyToHarness(harness.port);
  const response = await rawExchange(
    port,
    "GET /api/health HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\nConnection: close\r\n\r\nabcd",
  );
  expect(response).toMatch(/^HTTP\/1\.1 200 /);
  expect(harness.seen).toEqual([{ method: "GET", url: "/api/health", bytes: 0 }]);
});

const bodyHarness = async () => {
  const seen: { method?: string; url?: string; body: string; transferEncoding?: string }[] = [];
  const server = createServer((req, res) => {
    const entry = { method: req.method, url: req.url, body: "", transferEncoding: req.headers["transfer-encoding"] };
    seen.push(entry);
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      entry.body += chunk;
    });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return { seen, port: await listen(server) };
};

const SETUP_BODY = JSON.stringify({ threadId: "t1" });

it("a DELETE keeps its JSON body", async () => {
  const harness = await bodyHarness();
  const port = await proxyToHarness(harness.port);
  const response = await rawExchange(
    port,
    `DELETE /api/bots/b1/setup-request HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer paired\r\nContent-Type: application/json\r\n`
      + `Content-Length: ${SETUP_BODY.length}\r\nConnection: close\r\n\r\n${SETUP_BODY}`,
  );
  expect(response).toMatch(/^HTTP\/1\.1 200 /);
  expect(harness.seen).toEqual([{ method: "DELETE", url: "/api/bots/b1/setup-request", body: SETUP_BODY, transferEncoding: undefined }]);
});

it("a chunked DELETE reaches the harness as one request with its body", async () => {
  const harness = await bodyHarness();
  const port = await proxyToHarness(harness.port);
  const response = await rawExchange(
    port,
    `DELETE /api/bots/b1/setup-request HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer paired\r\nContent-Type: application/json\r\n`
      + `Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n${SETUP_BODY.length.toString(16)}\r\n${SETUP_BODY}\r\n0\r\n\r\n`,
  );
  expect(response).toMatch(/^HTTP\/1\.1 200 /);
  expect(harness.seen).toEqual([{ method: "DELETE", url: "/api/bots/b1/setup-request", body: SETUP_BODY, transferEncoding: "chunked" }]);
});
