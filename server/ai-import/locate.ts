import { basename, dirname, isAbsolute, join } from "node:path";

import { AI_IMPORT_LIMITS } from "../../shared/ai-import/limits.ts";
import type { LocalSource } from "./reader.ts";
import { isDirectory, isFile, listDirectories, sourceId } from "./local-fs.ts";

const HERMES_MARKERS = ["SOUL.md", "config.yaml", "state.db", "memories", "skills", "cron"];
const OPENCLAW_CONFIGS = ["openclaw.json", "clawdbot.json", "moltbot.json"];
const OPENCLAW_HOMES = [".openclaw", ".clawdbot", ".moltbot"];
const OPENCLAW_WORKSPACE = /^workspace(?:-(.+))?$/;

const absolute = (value: string | undefined): string | null => (value && isAbsolute(value) ? value : null);

async function exists(path: string): Promise<boolean> {
  return (await isFile(path)) || (await isDirectory(path));
}

async function looksLikeHermes(dir: string): Promise<boolean> {
  if (!(await isDirectory(dir))) return false;
  return (await Promise.all(HERMES_MARKERS.map((name) => exists(join(dir, name))))).some(Boolean);
}

function hermesHome(env: NodeJS.ProcessEnv, home: string): string {
  const fromEnv = absolute(env.HERMES_HOME);
  if (fromEnv) return fromEnv;
  const local = process.platform === "win32" ? absolute(env.LOCALAPPDATA) : null;
  return local ? join(local, "hermes") : join(home, ".hermes");
}

function make(kind: LocalSource["kind"], path: string, name: string, profile?: string): LocalSource {
  return { id: sourceId(kind, path, profile), kind, path, name, ...(profile ? { profile } : {}) };
}

async function hermesSources(env: NodeJS.ProcessEnv, home: string): Promise<LocalSource[]> {
  const root = hermesHome(env, home);
  const found: LocalSource[] = [];
  if (await looksLikeHermes(root)) found.push(make("hermes", root, "Hermes"));
  for (const profile of await listDirectories(join(root, "profiles"))) {
    const dir = join(root, "profiles", profile);
    if (await looksLikeHermes(dir)) found.push(make("hermes", dir, `Hermes · ${profile}`, profile));
  }
  return found;
}

/** The first OpenClaw state folder that holds a config file or a workspace, tried in the order the tool itself used over time. */
export async function openclawStateDir(env: NodeJS.ProcessEnv, home: string): Promise<string | null> {
  const candidates = [absolute(env.OPENCLAW_STATE_DIR), ...OPENCLAW_HOMES.map((name) => join(home, name))].filter((dir): dir is string => dir !== null);
  for (const dir of candidates) {
    if (!(await isDirectory(dir))) continue;
    const configs = await Promise.all(OPENCLAW_CONFIGS.map((name) => isFile(join(dir, name))));
    if (configs.some(Boolean) || (await listDirectories(dir)).some((name) => OPENCLAW_WORKSPACE.test(name))) return dir;
  }
  return null;
}

export async function openclawConfigPath(stateDir: string): Promise<string | null> {
  for (const name of OPENCLAW_CONFIGS) if (await isFile(join(stateDir, name))) return join(stateDir, name);
  return null;
}

/** The state folder that belongs to an agent workspace: its parent for the standard layout, else the one found on this machine. */
export async function openclawStateDirOf(workspace: string, env: NodeJS.ProcessEnv, home: string): Promise<string | null> {
  if (OPENCLAW_WORKSPACE.test(basename(workspace)) && (await openclawConfigPath(dirname(workspace)))) return dirname(workspace);
  return openclawStateDir(env, home);
}

async function openclawSources(env: NodeJS.ProcessEnv, home: string): Promise<LocalSource[]> {
  const state = await openclawStateDir(env, home);
  if (!state) return [];
  const found: LocalSource[] = [];
  const seen = new Set<string>();
  const add = (path: string, agentId: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    found.push(make("openclaw", path, agentId === "main" ? "OpenClaw" : `OpenClaw · ${agentId}`, agentId));
  };
  for (const name of await listDirectories(state)) {
    const match = OPENCLAW_WORKSPACE.exec(name);
    if (match) add(join(state, name), match[1] ?? "main");
  }
  const custom = absolute(env.OPENCLAW_WORKSPACE_DIR);
  if (custom && (await isDirectory(custom))) add(custom, "main");
  return found;
}

async function claudeCodeSources(env: NodeJS.ProcessEnv, home: string): Promise<LocalSource[]> {
  const dir = absolute(env.CLAUDE_CONFIG_DIR) ?? join(home, ".claude");
  return (await isDirectory(dir)) ? [make("claude-code", dir, "Claude Code")] : [];
}

/** Names the folders only; a file is read for its name or never. Stops adding sources once locateMs has passed. */
export async function locateLocalSources(env: NodeJS.ProcessEnv, home: string): Promise<LocalSource[]> {
  const deadline = Date.now() + AI_IMPORT_LIMITS.locateMs;
  const found: LocalSource[] = [];
  for (const find of [hermesSources, openclawSources, claudeCodeSources]) {
    if (Date.now() >= deadline) break;
    found.push(...(await find(env, home)));
  }
  return found;
}
