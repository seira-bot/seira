import { describe, expect, it } from "vitest";

import { MAX_MCP_REDIRECTS, McpHttpError, ONE_BOT_REDIRECT_REFUSAL, RemoteMcpClient } from "./mcp-http.ts";
import { WAPILOT_MCP_URL } from "../shared/one-bot-mcp.ts";

interface Seen { url: string; method: string; body: string | undefined; redirect: RequestInit["redirect"]; contentType: string | null; headers: Record<string, string> }

/** A fetch with a script: `moves` maps a request URL to the redirect it answers; any other URL answers a tools/list. */
function scripted(moves: Record<string, { status: number; location?: string }>) {
  const seen: Seen[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    seen.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined, redirect: init?.redirect, contentType: headers.get("content-type"), headers: Object.fromEntries(headers) });
    const move = moves[url];
    if (move) return new Response(null, { status: move.status, headers: move.location === undefined ? {} : { location: move.location } });
    const id = typeof init?.body === "string" ? (JSON.parse(init.body) as { id?: number }).id : undefined;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [] } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { seen, fetchImpl };
}

const ask = (url: string, fetchImpl: typeof fetch) =>
  new RemoteMcpClient({ type: "http", url, headers: {} }, { fetch: fetchImpl }).request("tools/list", {}, AbortSignal.timeout(2_000));

describe("a redirect from an MCP server", () => {
  it("is followed here, with the same method and body for a 307 or 308", async () => {
    for (const status of [307, 308]) {
      const { seen, fetchImpl } = scripted({ "https://mcp.example.test/mcp": { status, location: "/mcp/" } });
      await expect(ask("https://mcp.example.test/mcp", fetchImpl)).resolves.toEqual({ tools: [] });
      expect(seen.map((entry) => entry.url)).toEqual(["https://mcp.example.test/mcp", "https://mcp.example.test/mcp/"]);
      expect(seen.every((entry) => entry.redirect === "manual" && entry.method === "POST")).toBe(true);
      expect(seen[1]?.body).toBe(seen[0]?.body);
    }
  });

  it("keeps the saved headers on a hop to the same origin, and drops them on a hop to another origin", async () => {
    const saved = { authorization: "Bearer x", "x-api-key": "y", cookie: "a=b" };
    const askWith = (url: string, fetchImpl: typeof fetch) =>
      new RemoteMcpClient({ type: "http", url, headers: saved }, { fetch: fetchImpl }).request("tools/list", {}, AbortSignal.timeout(2_000));
    const same = scripted({ "https://a.example.test/mcp": { status: 307, location: "https://a.example.test/mcp/" } });
    await askWith("https://a.example.test/mcp", same.fetchImpl);
    expect(same.seen[1]?.headers).toMatchObject(saved);

    const cross = scripted({ "https://a.example.test/mcp": { status: 307, location: "https://b.example.test/mcp" } });
    await expect(askWith("https://a.example.test/mcp", cross.fetchImpl)).resolves.toEqual({ tools: [] });
    expect(cross.seen[0]?.headers).toMatchObject(saved);
    expect(Object.keys(cross.seen[1]?.headers ?? {}).sort()).toEqual(["accept", "content-type"]);
    expect(cross.seen[1]?.body).toBe(cross.seen[0]?.body);
  });

  it("does not send the saved headers again on a later hop back to the first origin", async () => {
    const saved = { authorization: "Bearer x" };
    const { seen, fetchImpl } = scripted({
      "https://a.example.test/mcp": { status: 307, location: "https://b.example.test/mcp" },
      "https://b.example.test/mcp": { status: 307, location: "https://a.example.test/final" },
    });
    await new RemoteMcpClient({ type: "http", url: "https://a.example.test/mcp", headers: saved }, { fetch: fetchImpl }).request("tools/list", {}, AbortSignal.timeout(2_000));
    expect(seen.map((entry) => entry.url)).toEqual(["https://a.example.test/mcp", "https://b.example.test/mcp", "https://a.example.test/final"]);
    expect(seen[2]?.headers.authorization).toBeUndefined();
  });

  it("turns a POST into a GET with no body for a 301, 302 or 303", async () => {
    for (const status of [301, 302, 303]) {
      const { seen, fetchImpl } = scripted({ "https://mcp.example.test/mcp": { status, location: "https://other.example.test/mcp" } });
      await ask("https://mcp.example.test/mcp", fetchImpl).catch(() => {});
      expect(seen[1]).toMatchObject({ url: "https://other.example.test/mcp", method: "GET", body: undefined, contentType: null });
    }
  });

  it("is refused, and never sent, when it goes to a one-bot address", async () => {
    const targets = [WAPILOT_MCP_URL, "https://integrator.wapilot.id./v1/%6Dcp", "https://INTEGRATOR.wapilot.id/V1/MCP/", "/v1/mcp"];
    for (const location of targets) {
      const from = location.startsWith("/") ? "https://integrator.wapilot.id/other" : "https://mcp.example.test/mcp";
      const { seen, fetchImpl } = scripted({ [from]: { status: 307, location } });
      await expect(ask(from, fetchImpl), location).rejects.toMatchObject({ name: "McpHttpError", message: ONE_BOT_REDIRECT_REFUSAL });
      expect(seen.map((entry) => entry.url), location).toEqual([from]);
    }
  });

  it("is refused after several hops when a later hop goes to a one-bot address", async () => {
    const { seen, fetchImpl } = scripted({
      "https://a.example.test/mcp": { status: 307, location: "https://b.example.test/mcp" },
      "https://b.example.test/mcp": { status: 307, location: WAPILOT_MCP_URL },
    });
    await expect(ask("https://a.example.test/mcp", fetchImpl)).rejects.toThrow(ONE_BOT_REDIRECT_REFUSAL);
    expect(seen.map((entry) => entry.url)).toEqual(["https://a.example.test/mcp", "https://b.example.test/mcp"]);
  });

  it("may stay on a one-bot address when the saved server is one", async () => {
    const { seen, fetchImpl } = scripted({ [WAPILOT_MCP_URL]: { status: 307, location: `${WAPILOT_MCP_URL}/` } });
    await expect(ask(WAPILOT_MCP_URL, fetchImpl)).resolves.toEqual({ tools: [] });
    expect(seen).toHaveLength(2);
  });

  it("is refused with no address, an unreadable address, or after too many hops", async () => {
    for (const location of [undefined, "http://[bad"]) {
      const { fetchImpl } = scripted({ "https://mcp.example.test/mcp": { status: 307, ...(location === undefined ? {} : { location }) } });
      const failure = await ask("https://mcp.example.test/mcp", fetchImpl).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(McpHttpError);
      expect(failure).toMatchObject({ kind: "protocol", message: "redirect with no usable address" });
    }
    const loop: Record<string, { status: number; location: string }> = {};
    for (let i = 0; i <= MAX_MCP_REDIRECTS; i++) loop[`https://mcp.example.test/${i}`] = { status: 307, location: `/${i + 1}` };
    const { seen, fetchImpl } = scripted(loop);
    await expect(ask("https://mcp.example.test/0", fetchImpl)).rejects.toThrow("too many redirects");
    expect(seen).toHaveLength(MAX_MCP_REDIRECTS + 1);
  });
});
