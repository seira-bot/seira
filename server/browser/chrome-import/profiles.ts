import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ChromeBrowser = "chrome" | "edge" | "brave" | "chromium";

export const MAX_COOKIE_DB_BYTES = 64 * 1024 * 1024;

export interface DetectDeps {
  home?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}

export interface BrowserProfile {
  /** Stable across runs, such as `chrome:Default` or `chromium:Default:Snap`. */
  id: string;
  name: string;
  browser: ChromeBrowser;
  browserName: string;
  lastUsed: boolean;
  cookiesPath: string;
  /** The cookie database and its journal together exceed `MAX_COOKIE_DB_BYTES`. */
  tooLarge: boolean;
}

interface BrowserLayout {
  browser: ChromeBrowser;
  browserName: string;
  linuxDir: string;
  flatpak: string;
  macDir: string;
}

const BROWSERS: BrowserLayout[] = [
  { browser: "chrome", browserName: "Chrome", linuxDir: "google-chrome", flatpak: "com.google.Chrome", macDir: "Google/Chrome" },
  { browser: "edge", browserName: "Edge", linuxDir: "microsoft-edge", flatpak: "com.microsoft.Edge", macDir: "Microsoft Edge" },
  { browser: "brave", browserName: "Brave", linuxDir: "BraveSoftware/Brave-Browser", flatpak: "com.brave.Browser", macDir: "BraveSoftware/Brave-Browser" },
  { browser: "chromium", browserName: "Chromium", linuxDir: "chromium", flatpak: "org.chromium.Chromium", macDir: "Chromium" },
];

const PROFILE_DIR = /^(Default|Profile \d+)$/u;

interface Root { layout: BrowserLayout; path: string; variant: string }

function roots(home: string, env: Record<string, string | undefined>, platform: NodeJS.Platform): Root[] {
  if (platform === "darwin") {
    return BROWSERS.map((layout) => ({ layout, path: join(home, "Library", "Application Support", layout.macDir), variant: "" }));
  }
  if (platform !== "linux") return [];
  const config = env.XDG_CONFIG_HOME || join(home, ".config");
  const found: Root[] = [];
  for (const layout of BROWSERS) {
    found.push({ layout, path: join(config, layout.linuxDir), variant: "" });
    found.push({ layout, path: join(home, ".var", "app", layout.flatpak, "config", layout.linuxDir), variant: "Flatpak" });
    if (layout.browser === "chromium") found.push({ layout, path: join(home, "snap", "chromium", "common", "chromium"), variant: "Snap" });
  }
  return found;
}

interface LocalState { lastUsed: string | null; names: Map<string, string> }

function readLocalState(root: string): LocalState {
  const state: LocalState = { lastUsed: null, names: new Map() };
  try {
    const parsed = JSON.parse(readFileSync(join(root, "Local State"), "utf8")) as { profile?: { last_used?: unknown; info_cache?: Record<string, { name?: unknown }> } };
    if (typeof parsed.profile?.last_used === "string") state.lastUsed = parsed.profile.last_used;
    for (const [dir, info] of Object.entries(parsed.profile?.info_cache ?? {})) {
      if (typeof info?.name === "string" && info.name.trim()) state.names.set(dir, info.name.trim());
    }
  } catch {}
  return state;
}

function sizeOf(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

function mtimeOf(path: string): number {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

function cookieFile(profileDir: string): string | null {
  return [join(profileDir, "Network", "Cookies"), join(profileDir, "Cookies")].find((path) => {
    try { return statSync(path).isFile(); } catch { return false; }
  }) ?? null;
}

function directories(root: string): string[] {
  if (!existsSync(root)) return [];
  try { return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && PROFILE_DIR.test(entry.name)).map((entry) => entry.name); }
  catch { return []; }
}

/** Profiles that hold a cookie database, the last-used profile of each browser first, then the most recently written. */
export function detectProfiles(deps: DetectDeps = {}): BrowserProfile[] {
  const found: Array<BrowserProfile & { modified: number }> = [];
  for (const root of roots(deps.home ?? homedir(), deps.env ?? process.env, deps.platform ?? process.platform)) {
    const state = readLocalState(root.path);
    for (const dir of directories(root.path)) {
      const cookiesPath = cookieFile(join(root.path, dir));
      if (!cookiesPath) continue;
      found.push({
        id: [root.layout.browser, dir, root.variant].filter(Boolean).join(":"),
        name: state.names.get(dir) ?? dir,
        browser: root.layout.browser,
        browserName: root.layout.browserName,
        lastUsed: state.lastUsed === dir,
        cookiesPath,
        tooLarge: sizeOf(cookiesPath) + sizeOf(`${cookiesPath}-wal`) > MAX_COOKIE_DB_BYTES,
        modified: Math.max(mtimeOf(cookiesPath), mtimeOf(`${cookiesPath}-wal`)),
      });
    }
  }
  return found
    .sort((a, b) => Number(b.lastUsed) - Number(a.lastUsed) || b.modified - a.modified || a.id.localeCompare(b.id))
    .map(({ modified: _modified, ...profile }) => profile);
}
