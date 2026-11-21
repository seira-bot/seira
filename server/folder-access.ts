import { realpathSync, statSync } from "node:fs";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import { z } from "zod";

import type { WireFolderAccess, WireFolderGrant } from "../shared/wire.ts";

export const MAX_FOLDERS = 20;

export type FolderGrant = WireFolderGrant;
export type FolderAccess = WireFolderAccess;

export const folderAccessSchema = z.object({
  limited: z.boolean(),
  folders: z.array(z.object({ path: z.string().min(1).max(4096), write: z.boolean() }).strict()).max(MAX_FOLDERS),
}).strict();

export type FolderRefusal = "invalid" | "relative" | "missing" | "notFolder" | "system" | "dataFolder" | "tooMany";

const REFUSAL_MESSAGE: Record<FolderRefusal, string> = {
  invalid: "That folder list is not valid.",
  relative: "Use the full path of the folder.",
  missing: "That folder isn't on this computer.",
  notFolder: "That is a file, not a folder.",
  system: "Choose one of your own folders, not a system folder.",
  dataFolder: "Seira keeps its own data there. Choose another folder.",
  tooMany: "You can add up to 20 folders.",
};

const POSIX_SYSTEM = ["/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libx32", "/proc", "/run", "/sbin", "/sys", "/usr",
  "/var/lib", "/var/run", "/System", "/Library", "/private/etc", "/private/var/db", "/private/var/root", "/private/var/run"];

function windowsSystem(): string[] {
  return [process.env.SystemRoot || "C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData"];
}

const fold = (path: string, caseless: boolean): string => caseless ? path.toLowerCase() : path;

function within(path: string, folder: string, caseless: boolean): boolean {
  const rel = relative(fold(resolve(folder), caseless), fold(resolve(path), caseless));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** True when `path` is `folder` or below it, on resolved paths: "/a/bc" is not inside "/a/b". */
export function insideFolder(path: string, folder: string): boolean {
  return within(path, folder, process.platform === "win32");
}

function realFolder(path: string): string | null {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function dataFolderPath(dataDir: string): string {
  try { return realpathSync(dataDir); } catch { return resolve(dataDir); }
}

const overlapsData = (path: string, data: string, caseless: boolean): boolean => within(path, data, caseless) || within(data, path, caseless);

function isSystemFolder(path: string, platform: NodeJS.Platform): boolean {
  const windows = platform === "win32";
  if (windows ? /^[A-Za-z]:[\\/]*$/.test(path) : path === "/") return true;
  if (!windows && parse(path).root === path) return true;
  return (windows ? windowsSystem() : POSIX_SYSTEM).some(folder => within(path, folder, windows));
}

type Refused = { ok: false; refusal: FolderRefusal; path?: string; message: string };
const refuse = (refusal: FolderRefusal, path?: string): Refused => ({ ok: false, refusal, message: REFUSAL_MESSAGE[refusal], ...(path === undefined ? {} : { path }) });

function expandHome(path: string, home: string): string {
  return path === "~" ? home : path.startsWith("~/") || path.startsWith("~\\") ? resolve(home, path.slice(2)) : path;
}

export function validateFolderAccess(input: unknown, opts: { dataDir: string; home: string; platform?: NodeJS.Platform }): { ok: true; value: FolderAccess } | Refused {
  const platform = opts.platform ?? process.platform;
  const folders = (input as { folders?: unknown } | null)?.folders;
  if (Array.isArray(folders) && folders.length > MAX_FOLDERS) return refuse("tooMany");
  const parsed = folderAccessSchema.safeParse(input);
  if (!parsed.success) return refuse("invalid");
  const data = dataFolderPath(opts.dataDir);
  const caseless = platform === "win32";
  const kept = new Map<string, FolderGrant>();
  for (const entry of parsed.data.folders) {
    const wanted = expandHome(entry.path, opts.home);
    if (!isAbsolute(wanted)) return refuse("relative", entry.path);
    let real: string;
    try { real = realpathSync(wanted); } catch { return refuse("missing", entry.path); }
    try { if (!statSync(real).isDirectory()) return refuse("notFolder", entry.path); } catch { return refuse("missing", entry.path); }
    if (isSystemFolder(real, platform)) return refuse("system", entry.path);
    if (overlapsData(real, data, caseless)) return refuse("dataFolder", entry.path);
    kept.delete(real);
    kept.set(real, { path: real, write: entry.write });
  }
  return { ok: true, value: { limited: parsed.data.limited, folders: [...kept.values()] } };
}

export interface EffectiveGrant extends FolderGrant { from: "bot" | "department" }
export interface EffectiveFolderAccess {
  limited: boolean;
  limitedBy: "bot" | "department" | null;
  department: string | null;
  folders: EffectiveGrant[];
}

export function effectiveFolderAccess(bot: FolderAccess | undefined, department: { name: string; access: FolderAccess | undefined } | null): EffectiveFolderAccess {
  const botPaths = new Set((bot?.folders ?? []).map(folder => folder.path));
  const fromDepartment = (department?.access?.folders ?? []).filter(folder => !botPaths.has(folder.path))
    .map((folder): EffectiveGrant => ({ ...folder, from: "department" }));
  const fromBot = (bot?.folders ?? []).map((folder): EffectiveGrant => ({ ...folder, from: "bot" }));
  const departmentLimits = department?.access?.limited === true;
  const botLimits = bot?.limited === true;
  return {
    limited: departmentLimits || botLimits,
    limitedBy: departmentLimits ? "department" : botLimits ? "bot" : null,
    department: department?.name ?? null,
    folders: [...fromDepartment, ...fromBot],
  };
}

export interface TurnFolders { limited: boolean; grants: FolderGrant[] }

export function resolveGrantsForTurn(access: EffectiveFolderAccess, opts: { dataDir: string; log?: (line: string) => void }): TurnFolders | null {
  const caseless = process.platform === "win32";
  const data = dataFolderPath(opts.dataDir);
  const grants: FolderGrant[] = [];
  for (const grant of access.folders) {
    const real = realFolder(grant.path);
    const reason = real === null ? "is not a folder now"
      : fold(real, caseless) !== fold(grant.path, caseless) ? "has moved or changed"
      : overlapsData(real, data, caseless) ? "overlaps Seira's data folder" : null;
    if (reason !== null) opts.log?.(`folder access: left out ${grant.path} (${reason})`);
    else grants.push({ path: grant.path, write: grant.write });
  }
  return access.limited || grants.length > 0 ? { limited: access.limited, grants } : null;
}
