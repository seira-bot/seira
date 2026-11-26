// Seira's own agents, connected-apps, data, Email, phone and GitHub servers answer chat-completions turns in the server process:
// a turn starts no Node process for them, and every call still reaches the harness only through the turn's capability token.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GITHUB_APP_MCP_SERVER } from "../../shared/github-app.ts";
import { harnessMcpTokenEnv } from "../harness-mcp-token.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { ChatMcpClient, mountChatTools, type ChatToolSession } from "./chat-mcp-tools.ts";

const spawned = vi.hoisted(() => [] as string[][]);
vi.mock("../procs.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../procs.ts")>();
  return {
    ...actual,
    spawnCli: (...args: Parameters<typeof actual.spawnCli>) => {
      spawned.push(args[1]);
      return actual.spawnCli(...args);
    },
  };
});

type Seen = { url: string; authorization?: string; closed: Promise<void> };
type Harness = { url: string; seen: Seen[]; server: HttpServer };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  spawned.length = 0;
});

async function harness(answer: (request: IncomingMessage, response: ServerResponse) => void): Promise<Harness> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    const closed = new Promise<void>((resolve) => response.once("close", () => resolve()));
    seen.push({ url: request.url ?? "", authorization: request.headers.authorization, closed });
    answer(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the harness did not bind TCP");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${address.port}`, seen, server };
}

function agents(url: string) {
  return {
    command: process.execPath,
    args: [SPAWNED_PROXIES.agents],
    env: { SEIRA_HARNESS_URL: url, SEIRA_BOT_ID: "bot-here", SEIRA_THREAD_ID: "thread-here", SEIRA_COMMS_TOKEN: "comms-here" },
  };
}

async function mount(url: string): Promise<{ session: ChatToolSession; controller: AbortController }> {
  const controller = new AbortController();
  const session = await mountChatTools({ agents: agents(url) }, controller.signal);
  cleanups.push(() => session.close());
  return { session, controller };
}

describe("the agents server on a chat-completions turn", () => {
  it("lists its tools and answers a call without starting a process", async () => {
    const h = await harness((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ bots: [{ id: "bot-peer", name: "Peer", model: "fixture-model" }] }));
    });
    const { session, controller } = await mount(h.url);

    expect(session.definitions.map((definition) => definition.function.name)).toContain("agents_list_bots");
    const result = await session.execute("agents_list_bots", {}, controller.signal);

    expect(result.ok).toBe(true);
    expect(result.text).toContain("- Peer [id: bot-peer, model: fixture-model");
    expect(h.seen[0]!.url).toBe("/api/internal/agents?self=bot-here");
    expect(h.seen.every((request) => request.url.startsWith("/api/internal/") && request.authorization === "Bearer comms-here")).toBe(true);
    expect(spawned).toEqual([]);
  });

  it("gives back the harness's refusal as a failed tool result", async () => {
    const h = await harness((_request, response) => {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "That bot is not yours." }));
    });
    const { session, controller } = await mount(h.url);

    const result = await session.execute("agents_list_bots", {}, controller.signal);

    expect(result.ok).toBe(false);
    expect(result.text).toContain("That bot is not yours.");
    expect(spawned).toEqual([]);
  });

  it("drops a harness request still in flight when the turn closes its tools", async () => {
    let arrived!: () => void;
    const waiting = new Promise<void>((resolve) => { arrived = resolve; });
    const h = await harness(() => arrived());
    const { session, controller } = await mount(h.url);

    const settled = session.execute("agents_list_bots", {}, controller.signal).then(() => {}, () => {});
    await waiting;
    await session.close();

    await h.seen[0]!.closed;
    await settled;
  });

  it.each([["data", "data"], ["github", GITHUB_APP_MCP_SERVER]] as const)("lists and calls the %s tools through the harness without starting a process", async (kind, server) => {
    const methods: string[] = [];
    const h = await harness(async (request, response) => {
      let body = "";
      for await (const part of request) body += String(part);
      const { method } = JSON.parse(body) as { method: string };
      methods.push(method);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(method === "tools/list"
        ? { result: { tools: [{ name: "query", description: "Run SQL.", inputSchema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] } }] } }
        : { result: { content: [{ type: "text", text: "3 rows" }] } }));
    });
    const controller = new AbortController();
    const descriptor = { command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, kind], env: { [harnessMcpTokenEnv(kind)]: `${kind}-here`, SEIRA_HARNESS_URL: h.url } };
    const session = await mountChatTools({ [kind]: descriptor }, controller.signal);
    cleanups.push(() => session.close());

    expect(session.definitions.map((definition) => definition.function.name)).toEqual([`${server}_query`]);
    await expect(session.execute(`${server}_query`, { sql: "select 1" }, controller.signal)).resolves.toMatchObject({ ok: true, text: "3 rows" });
    expect(methods).toEqual(["tools/list", "tools/call"]);
    expect(h.seen.every((request) => request.url === `/api/internal/${kind}/mcp` && request.authorization === `Bearer ${kind}-here`)).toBe(true);
    expect(spawned).toEqual([]);
  });

  it("relays the connected-apps tools to the harness without starting a process", async () => {
    const methods: string[] = [];
    const h = await harness(async (request, response) => {
      let body = "";
      for await (const part of request) body += String(part);
      const message = JSON.parse(body) as { id?: number; method: string };
      methods.push(message.method);
      response.setHeader("content-type", "application/json");
      if (message.id === undefined) { response.end("{}"); return; }
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.method === "tools/list"
        ? { tools: [{ name: "GMAIL_SEND_EMAIL", description: "Send an email.", inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] } }] }
        : message.method === "tools/call" ? { content: [{ type: "text", text: "sent" }] } : {} }));
    });
    const controller = new AbortController();
    const composio = { command: process.execPath, args: [SPAWNED_PROXIES.connectors], env: {
      SEIRA_CONNECTOR_UPSTREAM_URL: `${h.url}/api/internal/connectors/mcp`, SEIRA_CONNECTOR_UPSTREAM_HEADERS: JSON.stringify({ authorization: "Bearer connectors-here" }),
      SEIRA_HARNESS_URL: h.url, SEIRA_CONNECTOR_TOKEN: "connectors-here", SEIRA_BOT_ID: "bot-here", SEIRA_THREAD_ID: "thread-here",
    } };
    const session = await mountChatTools({ composio }, controller.signal);
    cleanups.push(() => session.close());

    expect(session.definitions.map((definition) => definition.function.name)).toEqual(["composio_gmail_send_email"]);
    await expect(session.execute("composio_gmail_send_email", { to: "a@example.com" }, controller.signal)).resolves.toMatchObject({ ok: true, text: "sent" });
    expect(methods).toEqual(expect.arrayContaining(["initialize", "tools/list", "tools/call"]));
    expect(h.seen.every((request) => request.url === "/api/internal/connectors/mcp" && request.authorization === "Bearer connectors-here")).toBe(true);
    expect(spawned).toEqual([]);
  });

  it("still starts a process for a server that only looks like it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seira-chat-mcp-here-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const script = join(dir, "agents-proxy.mjs");
    writeFileSync(script, `
      import readline from "node:readline";
      const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
      readline.createInterface({ input: process.stdin }).on("line", (line) => {
        const message = JSON.parse(line);
        if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1" } } });
        else if (message.method === "tools/list") send({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
      });
    `);
    const controller = new AbortController();
    const configured = new ChatMcpClient(agents("http://127.0.0.1:9"), false, true);
    const browser = new ChatMcpClient({ command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, "browser"], env: {} });
    const other = new ChatMcpClient({ ...agents("http://127.0.0.1:9"), args: [script] });
    cleanups.push(() => configured.close(), () => browser.close(), () => other.close());

    await expect(other.tools(controller.signal)).resolves.toEqual([]);
    expect(spawned).toEqual([[SPAWNED_PROXIES.agents], [SPAWNED_PROXIES.harnessMcp, "browser"], [script]]);
  });
});
