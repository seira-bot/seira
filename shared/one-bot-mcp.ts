/** Hosted MCP endpoints that may serve exactly one bot, never every bot. The service can read and send as the person,
 * so the server holds this rule itself. The Plugins card table (src/lib/hosted-mcp-apps.ts) reads the same address. */
export const WAPILOT_MCP_URL = "https://integrator.wapilot.id/v1/mcp";

export const ONE_BOT_MCP_ENDPOINTS: readonly string[] = [WAPILOT_MCP_URL];

export const ONE_BOT_MCP_REFUSAL = "This app serves one bot only. Choose one bot of this workspace for it first.";

interface McpAddress { type?: string; url?: string }

/** Whether this server is one of `endpoints`: https, the same origin, the same path with or without a trailing slash.
 * A query, a fragment or user information does not make a different endpoint. A name or label never decides it. */
export function isOneBotMcpServer(server: McpAddress, endpoints: readonly string[] = ONE_BOT_MCP_ENDPOINTS): boolean {
  if ((server.type !== "http" && server.type !== "sse") || !server.url) return false;
  let address: URL;
  try { address = new URL(server.url); } catch { return false; }
  if (address.protocol !== "https:") return false;
  const trimmed = (path: string) => path.replace(/\/+$/, "");
  return endpoints.some((endpoint) => {
    const own = new URL(endpoint);
    return address.origin === own.origin && trimmed(address.pathname) === trimmed(own.pathname);
  });
}

/** Why this server may not be saved or switched on, or null. A one-bot endpoint needs a `bot` that exists now. */
export function oneBotMcpProblem(
  server: McpAddress & { bot?: string },
  botExists: (id: string) => boolean,
  endpoints: readonly string[] = ONE_BOT_MCP_ENDPOINTS,
): string | null {
  if (!isOneBotMcpServer(server, endpoints)) return null;
  return typeof server.bot === "string" && server.bot !== "" && botExists(server.bot) ? null : ONE_BOT_MCP_REFUSAL;
}
