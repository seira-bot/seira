import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { cp } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { compareVersions, versionOf } from "./profile.ts";

const NEVER_COPIED = new Set([
  "SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort",
  "Cache", "Code Cache", "GPUCache", "ShaderCache", "GrShaderCache", "GraphiteDawnCache", "DawnGraphiteCache", "DawnWebGPUCache",
  "component_crx_cache", "Crashpad",
]);

export type SeedOutcome = "copied" | "newer-chrome" | "occupied";

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
 * the DevTools port file, caches and symbolic links do not. The copy lands under a temporary name and moves into place
 * whole, so a failed copy leaves no half profile behind. A source last opened by a newer Chrome than `binaryVersion`
 * is not copied, as an older Chrome would damage what the newer one wrote.
 */
export async function seedProfile(source: string, target: string, binaryVersion: string): Promise<SeedOutcome> {
  const opened = lastVersion(source);
  if (opened && compareVersions(versionOf(binaryVersion), opened) < 0) return "newer-chrome";
  if (existsSync(target) && readdirSync(target).length > 0) return "occupied";
  const staging = `${target}.seeding`;
  rmSync(staging, { recursive: true, force: true });
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
