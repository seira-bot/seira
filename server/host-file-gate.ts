import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { insideFolder, type TurnFolders } from "./folder-access.ts";
import type { ControlState } from "./control-client.ts";
import { HOST_FILE_TOOL_NAMES, hostFileLocation } from "./host-file-tools.ts";

export const FOLDER_NOT_OPEN = "This folder is not open to this bot.";
export const FOLDER_READ_ONLY = "This folder is read-only for this bot.";

const WRITES: ReadonlySet<string> = new Set(["write_file", "make_folder"]);

/** The real location of a path that may not exist yet: its nearest existing parent, resolved, with the rest put back. */
async function realLocation(target: string): Promise<string> {
  const rest: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

export interface HostFileCall {
  folders: TurnFolders | null;
  /** The bot's own folders for the conversation, without the folders a person opened to it. */
  ownRoots: readonly string[];
  query: URLSearchParams;
  home?: string;
}

/** The refusal for one host file call, or null when it may go on. Without a folder setting every call may. */
export async function hostFileRefusal(call: HostFileCall): Promise<string | null> {
  const { folders } = call;
  if (!folders) return null;
  const tool = call.query.get("tool");
  if (!tool || !HOST_FILE_TOOL_NAMES.has(tool)) return folders.limited ? FOLDER_NOT_OPEN : null;
  if (call.query.get("pathInvalid") === "1") return FOLDER_NOT_OPEN;
  const raw = call.query.get("path");
  if (raw === null && tool !== "list_files") return null;
  const home = call.home ?? homedir();
  const wanted = raw === null || raw === "" ? home : hostFileLocation(home, raw);
  if (wanted === null) return folders.limited ? FOLDER_NOT_OPEN : null;
  const target = await realLocation(wanted);
  const holders = [
    ...await Promise.all(call.ownRoots.map(async (root) => ({ path: await realLocation(root), write: true }))),
    ...await Promise.all(folders.grants.map(async (grant) => ({ path: await realLocation(grant.path), write: grant.write }))),
  ].filter((holder) => insideFolder(target, holder.path));
  if (holders.length === 0) return folders.limited ? FOLDER_NOT_OPEN : null;
  const deepest = holders.reduce((best, holder) =>
    holder.path.length > best.path.length || (holder.path.length === best.path.length && holder.write) ? holder : best);
  return WRITES.has(tool) && !deepest.write ? FOLDER_READ_ONLY : null;
}

export async function hostFileGate(call: HostFileCall): Promise<ControlState | null> {
  const refusal = await hostFileRefusal(call);
  return refusal ? { held: true, helpOpen: false, blockedReason: refusal } : null;
}
