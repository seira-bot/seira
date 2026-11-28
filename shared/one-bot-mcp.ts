/** Hosted MCP endpoints that may serve exactly one bot, never every bot. The service can read and send as the person,
 * so the server holds this rule itself. The Plugins card table (src/lib/hosted-mcp-apps.ts) reads the same address. */
export const WAPILOT_MCP_URL = "https://integrator.wapilot.id/v1/mcp";

export const ONE_BOT_MCP_ENDPOINTS: readonly string[] = [WAPILOT_MCP_URL];

export const ONE_BOT_MCP_REFUSAL = "This app serves one bot only. Choose one bot of this workspace for it first.";

interface McpAddress { type?: string; url?: string }

/** The host with no trailing dot, so `host.example.` and `host.example` name the same server. */
const bareHost = (url: URL) => url.hostname.replace(/\.$/, "");

/** The path in one fixed form: no trailing slash, percent-encoding of unreserved characters decoded (RFC 3986, 6.2.2.2),
 * and lower case. Reserved characters such as `%2F` stay encoded, because they can change what the path means. The
 * guard fails closed: a path that differs only by letter case counts as the same endpoint. */
const normalPath = (path: string) =>
  path
    .replace(/%([0-9a-f]{2})/gi, (match, hex: string) => {
      const char = String.fromCharCode(parseInt(hex, 16));
      return /[A-Za-z0-9\-._~]/.test(char) ? char : match;
    })
    .replace(/\/+$/, "")
    .toLowerCase();

/** Whether this server is one of `endpoints`: https, the same host and port, the same path with or without a trailing
 * slash. The compare ignores a trailing dot on the host, the letter case of the path, and percent-encoding of unreserved
 * characters in the path. A query, a fragment or user information does not make a different endpoint. A name or label
 * never decides it. A redirect that the remote server sends is not checked here. */
export function isOneBotMcpServer(server: McpAddress, endpoints: readonly string[] = ONE_BOT_MCP_ENDPOINTS): boolean {
  if ((server.type !== "http" && server.type !== "sse") || !server.url) return false;
  let address: URL;
  try { address = new URL(server.url); } catch { return false; }
  if (address.protocol !== "https:") return false;
  return endpoints.some((endpoint) => {
    const own = new URL(endpoint);
    return bareHost(address) === bareHost(own) && address.port === own.port
      && normalPath(address.pathname) === normalPath(own.pathname);
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
