import { describe, expect, it } from "vitest";

import { isOneBotMcpServer, ONE_BOT_MCP_ENDPOINTS, ONE_BOT_MCP_REFUSAL, oneBotMcpProblem, WAPILOT_MCP_URL } from "./one-bot-mcp";

const ENDPOINTS = ["https://one-bot.example.test/v1/mcp"];
const http = (url: string, type = "http") => ({ type, url });

describe("one-bot MCP endpoints", () => {
  it("lists the WAPilot endpoint", () => {
    expect(ONE_BOT_MCP_ENDPOINTS).toContain(WAPILOT_MCP_URL);
    expect(isOneBotMcpServer(http(WAPILOT_MCP_URL))).toBe(true);
  });

  it("matches by origin and path, and not by name", () => {
    expect(isOneBotMcpServer(http("https://one-bot.example.test/v1/mcp"), ENDPOINTS)).toBe(true);
    expect(isOneBotMcpServer(http("https://one-bot.example.test/v1/mcp/"), ENDPOINTS)).toBe(true);
    expect(isOneBotMcpServer(http("https://ONE-BOT.example.test:443/v1/mcp"), ENDPOINTS)).toBe(true);
    expect(isOneBotMcpServer(http("https://one-bot.example.test/v1/mcp", "sse"), ENDPOINTS)).toBe(true);
  });

  it("does not let a query, a fragment or user information hide the endpoint", () => {
    expect(isOneBotMcpServer(http("https://one-bot.example.test/v1/mcp?key=1"), ENDPOINTS)).toBe(true);
    expect(isOneBotMcpServer(http("https://one-bot.example.test/v1/mcp#x"), ENDPOINTS)).toBe(true);
    expect(isOneBotMcpServer(http("https://user:pass@one-bot.example.test/v1/mcp"), ENDPOINTS)).toBe(true);
  });

  it("does not match another host, port, path, scheme or a server with no address", () => {
    for (const url of ["https://one-bot.example.test.evil.test/v1/mcp", "https://one-bot.example.test:8443/v1/mcp", "https://one-bot.example.test/v1/other", "http://one-bot.example.test/v1/mcp", "not a url"]) {
      expect(isOneBotMcpServer(http(url), ENDPOINTS), url).toBe(false);
    }
    expect(isOneBotMcpServer({ type: "http" }, ENDPOINTS)).toBe(false);
    expect(isOneBotMcpServer({}, ENDPOINTS)).toBe(false);
  });

  it("needs a bot that exists for a one-bot endpoint, and leaves other servers alone", () => {
    const known = (id: string) => id === "alpha";
    const url = "https://one-bot.example.test/v1/mcp";
    expect(oneBotMcpProblem(http(url), known, ENDPOINTS)).toBe(ONE_BOT_MCP_REFUSAL);
    expect(oneBotMcpProblem({ ...http(url), bot: "" }, known, ENDPOINTS)).toBe(ONE_BOT_MCP_REFUSAL);
    expect(oneBotMcpProblem({ ...http(url), bot: "gone" }, known, ENDPOINTS)).toBe(ONE_BOT_MCP_REFUSAL);
    expect(oneBotMcpProblem({ ...http(url), bot: "alpha" }, known, ENDPOINTS)).toBeNull();
    expect(oneBotMcpProblem(http("https://other.example.test/mcp"), known, ENDPOINTS)).toBeNull();
  });
});
