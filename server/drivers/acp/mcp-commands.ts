import { isAbsolute } from "node:path";

import type { ProgramView } from "../../procs.ts";
import type { AcpMcpServer } from "../turn-mcp.ts";

export interface SkippedMcpServer {
  name: string;
  command: string;
  /** False when the place the engine runs the command could not be looked at, so the name was not even tried. */
  looked: boolean;
}

/** Absolute is judged for the platform the agent is started on: a path written for another one is not a command here.
 *
 * Some ACP agents reject `session/new` outright when a stdio MCP `command` is not an absolute path (dsh 0.2.2-rc.1:
 * "mcpServers[n].command must be an absolute path"). A bare command is looked up in `view`, the PATH and files of the place
 * the agent runs it, with no shell; a server whose command cannot be resolved there is left out so the rest of the turn
 * still starts. With no view the name is not guessed at. */
export function absoluteMcpCommands(servers: AcpMcpServer[], view: ProgramView | null): { servers: AcpMcpServer[]; skipped: SkippedMcpServer[] } {
  const skipped: SkippedMcpServer[] = [];
  const kept: AcpMcpServer[] = [];
  for (const server of servers) {
    if ("type" in server || isAbsolute(server.command)) {
      kept.push(server);
      continue;
    }
    const resolved = view?.find(server.command);
    if (resolved) kept.push({ ...server, command: resolved });
    else skipped.push({ name: server.name, command: server.command, looked: view !== null });
  }
  return { servers: kept, skipped };
}

export function skippedMcpNote(engine: string, skipped: SkippedMcpServer): string {
  const why = skipped.looked
    ? "was not found on PATH where it runs"
    : "could not be looked up where it runs";
  return `${engine} needs an absolute path for an MCP command. The MCP server "${skipped.name}" was left out of this turn because "${skipped.command}" is not an absolute path and ${why}. Set its command to a full path in Settings to use it.`;
}

/** The servers a turn hands the agent, and one note for each left out; `require` is set for an agent that needs
 * absolute commands, without it the servers pass through. */
export function turnMcpCommands(servers: AcpMcpServer[], require: { view: ProgramView | null; engine: string } | undefined): { servers: AcpMcpServer[]; notes: string[] } {
  if (!require) return { servers, notes: [] };
  const resolved = absoluteMcpCommands(servers, require.view);
  return { servers: resolved.servers, notes: resolved.skipped.map((skipped) => skippedMcpNote(require.engine, skipped)) };
}
