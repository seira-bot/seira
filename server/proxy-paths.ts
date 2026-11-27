// Resolve spawned proxies only here: esbuild inlines modules into entry bundles, so a relative path must be anchored at the server root.
import { existsSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_ROOT = dirname(fileURLToPath(import.meta.url));

export function resolveProxy(relative: string): string {
  const source = join(SERVER_ROOT, `${relative}.ts`);
  return existsSync(source) ? source : join(SERVER_ROOT, `${relative}.js`);
}

export const SPAWNED_PROXIES = {
  harnessMcp: resolveProxy("harness-mcp-proxy"),
  localComputer: resolveProxy("local-computer-proxy"),
  permission: resolveProxy("permission-proxy"),
  containerMcp: resolveProxy("container-mcp"),
  vpsContainerMcp: resolveProxy("vps-container-mcp"),
  agents: resolveProxy("drivers/agents-proxy"),
  dweb: resolveProxy("drivers/dweb-proxy"),
  connectors: resolveProxy("connector-proxy"),
  mcpGate: resolveProxy("mcp-gate"),
  mcpRemote: resolveProxy("mcp-remote-proxy"),
  phone: resolveProxy("drivers/phone-proxy"),
  chatgptPlanToken: resolveProxy("drivers/chatgpt-plan-token-command"),
  hook: resolveProxy("hooks/seira-hook"),
  piMcpExtension: resolveProxy("drivers/pi-mcp-extension"),
} as const;

// in the packaged app process.execPath is Electron — run the proxy as node
export const AGENTS_NODE_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

export const STORE_ALIAS = "seira-desktop.exe";

const STORE_PACKAGE_FOLDER = /\\WindowsApps\\([^\\_]+)_[^\\]*_([a-z0-9]{13})\\/i;

/** The program that runs Seira's scripts for another program, such as an agent engine. Windows lets a program outside a
 * Microsoft Store package start the package's executable only through its app execution alias, never by the full path
 * under WindowsApps (ERROR_ACCESS_DENIED, which Node and Bun report as EPERM). Windows keeps the alias of each package in
 * a folder named after its package family, also when the person turns the alias off in Settings. */
export function ownNodeCommand(execPath: string = process.execPath, env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): string {
  const folder = STORE_PACKAGE_FOLDER.exec(execPath);
  const localAppData = env.LOCALAPPDATA;
  if (!folder || !localAppData) return execPath;
  const apps = win32.join(localAppData, "Microsoft", "WindowsApps");
  for (const alias of [win32.join(apps, `${folder[1]}_${folder[2]}`, STORE_ALIAS), win32.join(apps, STORE_ALIAS)]) {
    if (exists(alias)) return alias;
  }
  return execPath;
}

export const OWN_NODE = ownNodeCommand();

/** A command that runs one of Seira's scripts. */
export function isOwnNode(command: string): boolean {
  return command === process.execPath || command === OWN_NODE;
}
