import { describe, expect, it } from "vitest";

import { McpHttpError, ONE_BOT_ENDPOINT_REFUSAL, RemoteMcpClient } from "./mcp-http.ts";
import { WAPILOT_MCP_URL, isOneBotMcpServer } from "../shared/one-bot-mcp.ts";

interface Seen { url: string; method: string; headers: Record<string, string> }

/** A fetch with a script: a GET opens an event stream that names `endpoint`; a POST is accepted with 202. */
function scripted(endpoint: string) {
  const seen: Seen[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers)) });
    if ((init?.method ?? "GET") === "GET") {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`event: endpoint\ndata: ${endpoint}\n\n`));
          init?.signal?.addEventListener("abort", () => { try { controller.close(); } catch { /* already closed */ } }, { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(null, { status: 202 });
  };
  return { seen, fetchImpl };
}

const openWith = async (from: string, endpoint: string, headers: Record<string, string> = {}) => {
  const { seen, fetchImpl } = scripted(endpoint);
  const client = new RemoteMcpClient({ type: "sse", url: from, headers }, { fetch: fetchImpl });
  const reply = client.request("tools/list", {}, AbortSignal.timeout(300)).catch((error: unknown) => error);
  const outcome = await reply;
  await client.close();
  return { seen, outcome };
};

describe("the endpoint event of an SSE MCP server", () => {
  it("is refused, and nothing is sent to it, when it names a one-bot address", async () => {
    const endpoints = [WAPILOT_MCP_URL, "https://integrator.wapilot.id./v1/%6Dcp", "https://INTEGRATOR.wapilot.id/V1/MCP/", "/v1/mcp"];
    for (const endpoint of endpoints) {
      const from = endpoint.startsWith("/") ? "https://integrator.wapilot.id/sse" : "https://mcp.example.test/sse";
      const { seen, outcome } = await openWith(from, endpoint);
      expect(outcome, endpoint).toBeInstanceOf(McpHttpError);
      expect(outcome, endpoint).toMatchObject({ kind: "protocol", message: ONE_BOT_ENDPOINT_REFUSAL });
      expect(seen.filter((entry) => entry.method === "POST"), endpoint).toEqual([]);
    }
  });

  it("is accepted, and used for the request, when it names an ordinary address", async () => {
    for (const endpoint of ["/messages?session=1", "https://other.example.test/messages"]) {
      const { seen, outcome } = await openWith("https://mcp.example.test/sse", endpoint);
      expect(outcome, endpoint).not.toMatchObject({ message: ONE_BOT_ENDPOINT_REFUSAL });
      const posts = seen.filter((entry) => entry.method === "POST").map((entry) => entry.url);
      expect(posts.length, endpoint).toBeGreaterThan(0);
      expect(new Set(posts), endpoint).toEqual(new Set([new URL(endpoint, "https://mcp.example.test/sse").toString()]));
    }
  });

  it("may name its own one-bot address when the saved server is one", async () => {
    // Each of these matches the one-bot rule; only the saved server being that address lets it through.
    for (const endpoint of [WAPILOT_MCP_URL, `${WAPILOT_MCP_URL}/`, `${WAPILOT_MCP_URL}?session=1`, "/v1/mcp"]) {
      expect(isOneBotMcpServer({ type: "http", url: new URL(endpoint, WAPILOT_MCP_URL).toString() }), endpoint).toBe(true);
      const { seen, outcome } = await openWith(WAPILOT_MCP_URL, endpoint);
      expect(outcome, endpoint).not.toMatchObject({ message: ONE_BOT_ENDPOINT_REFUSAL });
      expect(seen.filter((entry) => entry.method === "POST").length, endpoint).toBeGreaterThan(0);
    }
  });
});

describe("the saved headers of an SSE MCP server", () => {
  const saved = { authorization: "Bearer x", "x-api-key": "y", cookie: "a=b" };

  it("go to the stream and to an endpoint on the same origin", async () => {
    const { seen } = await openWith("https://mcp.example.test/sse", "/messages", saved);
    const sent = seen.filter((entry) => entry.method === "GET" || entry.method === "POST");
    expect(sent.length).toBeGreaterThan(1);
    for (const entry of sent) expect(entry.headers, entry.url).toMatchObject(saved);
  });

  it("do not go to an endpoint on another origin: only accept and content-type go on", async () => {
    const { seen } = await openWith("https://mcp.example.test/sse", "https://other.example.test/messages", saved);
    expect(seen[0]?.headers).toMatchObject(saved);
    const posts = seen.filter((entry) => entry.method === "POST");
    expect(posts.length).toBeGreaterThan(0);
    for (const entry of posts) {
      expect(entry.url).toBe("https://other.example.test/messages");
      expect(Object.keys(entry.headers).sort()).toEqual(["accept", "content-type"]);
    }
  });
});
