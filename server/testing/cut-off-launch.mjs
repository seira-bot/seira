// Run by launch-folders.test.ts: starts one call that makes a temp folder and never ends, prints the folders, then
// exits the way a server that is stopped in the middle of that call does.
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [scenario, cli] = process.argv.slice(2);
const PREFIXES = {
  muse: ["seira-muse-models-"],
  acp: ["seira-acp-models-"],
  background: ["seira-claude-background-"],
  turn: ["seira-mcp-", "seira-system-"],
};

if (scenario === "muse") {
  const { MuseCodeDriver } = await import("../drivers/muse-code.ts");
  const instance = await MuseCodeDriver.create({ instanceId: "museCode", displayName: "Muse Code", enabled: true,
    environment: {}, config: MuseCodeDriver.decodeConfig({ cli }) });
  void instance.refreshModels();
} else if (scenario === "acp") {
  const { discoverAcpModels } = await import("../drivers/acp/custom-model-catalog.ts");
  void discoverAcpModels({}, cli, []).catch(() => {});
} else {
  const { ensureDirs } = await import("../config.ts");
  const { ClaudeDriver } = await import("../drivers/claude.ts");
  ensureDirs();
  const instance = await ClaudeDriver.create({ instanceId: "claude-cut-off", displayName: "Claude", environment: {}, enabled: true,
    config: { cli, permissionMode: "acceptEdits" } });
  if (scenario === "background") void instance.generateText("summarize").catch(() => {});
  else void instance.adapter.sendTurn({ threadId: "t-cut-off", text: "hi", system: "Be brief.",
    integrations: { composio: { command: process.execPath, args: ["connector-proxy.js"], env: {} } } }).catch(() => {});
}

const found = () => Object.fromEntries(PREFIXES[scenario].map((prefix) => [prefix, readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)).map((name) => join(tmpdir(), name))]));
for (let waited = 0; waited < 20_000 && !Object.values(found()).every((paths) => paths.length > 0); waited += 50) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
process.stdout.write(`${JSON.stringify({ pid: process.pid, folders: found() })}\n`);
process.exit(0);
