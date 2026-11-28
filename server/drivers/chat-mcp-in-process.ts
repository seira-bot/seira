import { connectorMcp } from "../connector-mcp.ts";
import { failure, HARNESS_MCP_MAX_PENDING, harnessMcpRequest, parseHarnessMcpKind, type HarnessMcpKind, type RpcId } from "../harness-mcp-request.ts";
import { harnessMcpTokenEnv } from "../harness-mcp-token.ts";
import { isOwnNode, SPAWNED_PROXIES } from "../proxy-paths.ts";
import { toolLimitFromEnv } from "../tool-count-limit.ts";
import type { Json } from "./agents-client.ts";
import { agentsMcp } from "./agents-mcp.ts";

/** An MCP server that answers in this process: `read` takes each line a process would read, and each reply comes back as
 * the line it would write. */
export type InProcessServer = { read(line: string): void; stop: AbortController };
type Answer = (message: Json) => Promise<unknown>;

/** The harness kinds that answer in this process; browser and computer frames carry screenshots, so they keep a process. */
const IN_PROCESS_KINDS: ReadonlySet<HarnessMcpKind> = new Set(["data", "email", "device", "github"]);

function harnessAnswer(kind: HarnessMcpKind, env: NodeJS.ProcessEnv, stop: AbortSignal): Answer {
  const connection = { url: env.SEIRA_HARNESS_URL ?? "", token: env[harnessMcpTokenEnv(kind)] ?? "", kind, toolLimit: toolLimitFromEnv(env) };
  let pending = 0;
  return async (message) => {
    if (pending >= HARNESS_MCP_MAX_PENDING) {
      return Object.hasOwn(message, "id") ? failure((message.id ?? null) as RpcId, message.method, `Too many pending ${kind} requests.`) : undefined;
    }
    pending++;
    try { return await harnessMcpRequest(message, connection, stop); }
    finally { pending--; }
  };
}

/** Seira's own agents, connected-apps, data, Email, phone and GitHub servers, as the harness launches them, answer in this process
 * for a chat-completions turn, as they do for engines that reach them by URL. Security: each reads the environment that
 * its process would get and reaches the harness only with the turn's capability token. `env` is the environment that the
 * spawned path gives the same server (`chatMcpEnvironment`), never the whole of `process.env`. */
export function inProcessServer(server: { command: string; args: string[] }, reply: (message: unknown) => void, env: NodeJS.ProcessEnv): InProcessServer | undefined {
  if (!isOwnNode(server.command)) return undefined;
  const [script, kindArgument, ...rest] = server.args;
  const stop = new AbortController();
  if (script === SPAWNED_PROXIES.connectors && kindArgument === undefined) {
    return { read: connectorMcp(env, reply, (line) => console.warn(`[connectors] ${line}`), stop.signal), stop };
  }
  const kind = script === SPAWNED_PROXIES.harnessMcp && rest.length === 0 ? parseHarnessMcpKind(kindArgument) : null;
  const answer: Answer | undefined = script === SPAWNED_PROXIES.agents && kindArgument === undefined ? agentsMcp(env, stop.signal)
    : kind && IN_PROCESS_KINDS.has(kind) ? harnessAnswer(kind, env, stop.signal) : undefined;
  if (!answer) return undefined;
  return {
    read: (line) => {
      const message = JSON.parse(line) as Json;
      void answer(message).then(
        (answered) => { if (answered) reply(answered); },
        (error: unknown) => {
          if (message.id !== undefined) reply({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
        },
      );
    },
    stop,
  };
}
