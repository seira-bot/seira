// Resolve spawned proxies only here: esbuild inlines modules into entry bundles, so a relative path must be anchored at the server root.
import { existsSync, readlinkSync } from "node:fs";
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

/** Where an app execution alias leads. Node reads an alias as a link to the executable it starts. */
export function aliasTarget(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

function storeAlias(execPath: string, env: NodeJS.ProcessEnv): string | null {
  const folder = STORE_PACKAGE_FOLDER.exec(execPath);
  const localAppData = env.LOCALAPPDATA;
  return folder && localAppData ? win32.join(localAppData, "Microsoft", "WindowsApps", `${folder[1]}_${folder[2]}`, STORE_ALIAS) : null;
}

/** The program that runs Seira's scripts for another program, such as an agent engine. On Windows 10 a program outside a
 * Microsoft Store package cannot start the package's executable by its full path under WindowsApps (ERROR_ACCESS_DENIED,
 * which Node and Bun report as EPERM). The app execution alias starts it from anywhere. Windows keeps the alias of each
 * package in a folder named after its package family, also when the person turns the alias off in Settings.
 * Security: the user can write to that folder, so the alias is used only when it leads to this executable. Each call reads
 * the alias again; call it for each launch configuration and never keep the result. */
export function ownNode(execPath: string = process.execPath, env: NodeJS.ProcessEnv = process.env, target: (path: string) => string | null = aliasTarget): string {
  const alias = storeAlias(execPath, env);
  const leadsTo = alias && target(alias);
  return alias && leadsTo && win32.normalize(leadsTo).toLowerCase() === win32.normalize(execPath).toLowerCase() ? alias : execPath;
}

/** A command that runs one of Seira's scripts. */
export function isOwnNode(command: string, execPath: string = process.execPath, env: NodeJS.ProcessEnv = process.env): boolean {
  return command === execPath || command === storeAlias(execPath, env);
}
