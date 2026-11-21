import type { TurnFolders } from "../folder-access.ts";
import { versionAtLeast } from "./acp/version-probe.ts";

type Version = readonly [number, number, number];

/** First Claude Code that honours `permissions.blockReadsOutsideWorkingDirectories`. */
export const CLAUDE_BLOCK_READS_FLOOR: Version = [2, 1, 257];
/** First Claude Code seen to know `permissions.blockWritesOutsideWorkingDirectories` (strings of 2.1.330). */
export const CLAUDE_BLOCK_WRITES_FLOOR: Version = [2, 1, 330];

const READ_ONLY_TOOLS = ["Edit", "Write", "NotebookEdit"] as const;

/** Claude Code permission rules write an absolute path with a leading `//`; a Windows drive letter becomes a folder. */
export function claudeRulePath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return `/${path}`;
  const slashed = path.replaceAll("\\", "/");
  const drive = /^([A-Za-z]):\/?(.*)$/.exec(slashed);
  return drive ? `//${drive[1].toLowerCase()}/${drive[2]}` : `/${slashed}`;
}

export function claudeFolderArgs(folders: TurnFolders | undefined): string[] {
  return (folders?.grants ?? []).flatMap((grant) => ["--add-dir", grant.path]);
}

/** Settings `permissions` for a turn's folders, or null when the turn has none. A deny rule beats an allow rule, so a
 * can-change grant inside a read-only grant is read-only too. */
export function claudeFolderPermissions(folders: TurnFolders | undefined, version: Version | null, platform: NodeJS.Platform = process.platform): Record<string, unknown> | null {
  if (!folders) return null;
  const permissions: Record<string, unknown> = {};
  if (folders.grants.length) permissions.additionalDirectories = folders.grants.map((grant) => grant.path);
  const deny = folders.grants.filter((grant) => !grant.write)
    .flatMap((grant) => READ_ONLY_TOOLS.map((tool) => `${tool}(${claudeRulePath(grant.path, platform)}/**)`));
  if (deny.length) permissions.deny = deny;
  if (folders.limited) {
    if (version === null || versionAtLeast(version, CLAUDE_BLOCK_READS_FLOOR)) permissions.blockReadsOutsideWorkingDirectories = true;
    if (version === null || versionAtLeast(version, CLAUDE_BLOCK_WRITES_FLOOR)) permissions.blockWritesOutsideWorkingDirectories = true;
  }
  return Object.keys(permissions).length ? permissions : null;
}
