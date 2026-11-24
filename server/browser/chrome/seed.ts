import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { cp } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { compareVersions, OLD_STAGING_NAME, seedingDir, versionOf } from "./profile.ts";

const NEVER_COPIED = new Set([
  "SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort",
  "Cache", "Code Cache", "GPUCache", "ShaderCache", "GrShaderCache", "GraphiteDawnCache", "DawnGraphiteCache", "DawnWebGPUCache",
  "component_crx_cache", "Crashpad",
]);

export type SeedOutcome = "copied" | "newer-chrome" | "occupied";

/** The browser a profile would be copied from is still open, so its files may change while they are copied. */
export class SourceStillOpen extends Error {
  constructor() {
    super("Your earlier browser is still open, so its saved sign-ins were not copied to the new browser. Close it and try again. The earlier browser's folder was not changed.");
    this.name = "SourceStillOpen";
  }
}

/**
 * Removes the copies a stopped process left, except those `busy` names (a copy running now): under `<browser root>/seeding`,
 * and the earlier layout's `<hash>.seeding` folders beside the profiles. Only that exact old name is matched, never another
 * folder in `profiles` or `temp`.
 */
export function removeStaleSeeding(browserRoot: string, busy: (profile: string) => boolean): void {
  const parent = join(browserRoot, "seeding");
  let names: string[] = [];
  try { names = readdirSync(parent); } catch {}
  for (const name of names) {
    if (busy(join(browserRoot, "profiles", name))) continue;
    rmSync(join(parent, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  for (const kind of ["profiles", "temp"]) {
    let beside: string[];
    try { beside = readdirSync(join(browserRoot, kind)); } catch { continue; }
    for (const name of beside) {
      if (!OLD_STAGING_NAME.test(name)) continue;
      const staging = join(browserRoot, kind, name);
      if (busy(staging) || busy(staging.slice(0, -".seeding".length))) continue;
      rmSync(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
}

/** The newest Chrome that opened a profile folder, from the `Last Version` file Chrome keeps in it. */
function lastVersion(source: string): string | null {
  try {
    const text = readFileSync(`${source}/Last Version`, "utf8").trim();
    return /^\d+(?:\.\d+){1,3}$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

/**
 * Copies another browser's profile folder into a profile that does not exist yet: signed-in sites come along, locks,
 * the DevTools port file, caches and symbolic links do not. The copy lands in `seedingDir` and moves into place whole,
 * so a failed copy leaves no half profile behind; one a stopped process left is removed at the next start or with the
 * profile. A source last opened by a newer Chrome than `binaryVersion` is not copied, as an older Chrome would damage
 * what the newer one wrote.
 */
export async function seedProfile(source: string, target: string, binaryVersion: string): Promise<SeedOutcome> {
  const opened = lastVersion(source);
  if (opened && compareVersions(versionOf(binaryVersion), opened) < 0) return "newer-chrome";
  if (existsSync(target) && readdirSync(target).length > 0) return "occupied";
  const staging = seedingDir(target);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(dirname(staging), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  try {
    await cp(source, staging, {
      recursive: true,
      filter: (path) => !NEVER_COPIED.has(basename(path)) && !lstatSync(path).isSymbolicLink(),
    });
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return "copied";
}
