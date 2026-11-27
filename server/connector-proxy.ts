// The connected-apps MCP server over stdio. stdout is the MCP transport: never log there.
import readline from "node:readline";

import { connectorMcp } from "./connector-mcp.ts";

const read = connectorMcp(
  process.env,
  (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
  (line) => process.stderr.write(`connector-proxy: ${line}\n`),
);
const input = readline.createInterface({ input: process.stdin, terminal: false });
input.on("line", read);
input.on("close", () => process.exit(0));
