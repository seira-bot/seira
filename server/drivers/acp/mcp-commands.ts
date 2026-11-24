import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute as isAbsolutePosix, win32 } from "node:path";

import { findCliCandidates } from "../../env-path.ts";
import type { AcpMcpServer } from "../turn-mcp.ts";

export interface SkippedMcpServer {
  name: string;
  command: string;
}

const isAbsoluteCommand = (command: string): boolean => isAbsolutePosix(command) || win32.isAbsolute(command);

function runnableOnPath(command: string, path: string): string | undefined {
  return findCliCandidates(command, path).find((candidate) => {
    if (!isAbsoluteCommand(candidate)) return false;
    try {
      if (!statSync(candidate).isFile()) return false;
      if (process.platform !== "win32") accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** Some ACP agents reject `session/new` outright when a stdio MCP `command` is not an absolute path (dsh 0.2.2-rc.1:
 * "mcpServers[n].command must be an absolute path"). A bare command is looked up on `path`, the PATH the agent gets, with
 * no shell; a server whose command cannot be resolved is left out so the rest of the turn still starts. */
export function absoluteMcpCommands(servers: AcpMcpServer[], path: string | undefined): { servers: AcpMcpServer[]; skipped: SkippedMcpServer[] } {
  const skipped: SkippedMcpServer[] = [];
  const kept: AcpMcpServer[] = [];
  for (const server of servers) {
    if ("type" in server || isAbsoluteCommand(server.command)) {
      kept.push(server);
      continue;
    }
    const resolved = path === undefined ? undefined : runnableOnPath(server.command, path);
    if (resolved) kept.push({ ...server, command: resolved });
    else skipped.push({ name: server.name, command: server.command });
  }
  return { servers: kept, skipped };
}

export function skippedMcpNote(engine: string, skipped: SkippedMcpServer): string {
  return `${engine} needs an absolute path for an MCP command. The MCP server "${skipped.name}" was left out of this turn because "${skipped.command}" is not an absolute path and was not found on PATH. Set its command to a full path in Settings to use it.`;
}

/** The servers a turn hands the agent, and one note for each left out; `require` is set for an agent that needs
 * absolute commands, without it the servers pass through. */
export function turnMcpCommands(servers: AcpMcpServer[], require: { path: string | undefined; engine: string } | undefined): { servers: AcpMcpServer[]; notes: string[] } {
  if (!require) return { servers, notes: [] };
  const resolved = absoluteMcpCommands(servers, require.path);
  return { servers: resolved.servers, notes: resolved.skipped.map((skipped) => skippedMcpNote(require.engine, skipped)) };
}
