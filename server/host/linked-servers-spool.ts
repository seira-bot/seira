// How many file bytes, files and hand-offs one linked server may keep waiting here before the frames that use them
// arrive, and how many the files this server gets from it may fill. Each link's files go to its own spool: one folder for
// each hand-off id, then one for each way.
import { readdirSync, rmdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { SPOOL_MAX_BYTES } from "../bot-link/link.ts";
import { FILES_MAX } from "../bot-link/protocol.ts";
import { ADMIT } from "./linked-servers-admit.ts";

export interface SpoolLimits {
  bytes: number;
  /** Hand-off ids with files waiting: the hand-offs a link may have open here, and as many results. */
  ids: number;
  /** Files waiting, in all: as many as those ids may carry. */
  files: number;
}

export const SPOOL_ROOM: SpoolLimits = { bytes: SPOOL_MAX_BYTES, ids: 2 * ADMIT.open, files: 2 * ADMIT.open * FILES_MAX };

/** Room in the spool at `root` for one file about to arrive: a release to call when its write ends, or null when the file
 * would take the spool past `limits`. A check reads no more of the spool than `limits` allow. */
export function createSpoolRoom(root: string, limits: SpoolLimits = SPOOL_ROOM) {
  const writing = new Map<string, number>();
  const idOf = (path: string) => relative(root, path).split(sep)[0] ?? "";

  /** The files and bytes waiting for each id, written or being written, with `to` about to be written again; null when
   * there are more than `limits` allow. */
  function waiting(to: string): { ids: Map<string, number>; files: number } | null {
    const ids = new Map<string, number>();
    let files = 0, seen = 0;
    const add = (id: string, bytes: number) => { ids.set(id, (ids.get(id) ?? 0) + bytes); };
    const over = () => files > limits.files || ids.size > limits.ids || seen > limits.files + 3 * (limits.ids + 1);
    let names: string[] = [];
    try { names = readdirSync(root); } catch { /* no file came yet */ }
    for (const name of names) {
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          seen += 1;
          if (over()) return;
          const path = join(dir, entry.name);
          if (entry.isDirectory()) walk(path);
          else if (path === to) add(name, 0);
          else if (!writing.has(path)) { files += 1; add(name, statSync(path).size); }
        }
      };
      seen += 1;
      try { walk(join(root, name)); } catch { /* removed while read */ }
      if (over()) return null;
    }
    for (const [path, bytes] of writing) { files += 1; add(idOf(path), bytes); }
    return over() ? null : { ids, files };
  }

  /** Removes the folders that a refused or failed file leaves empty, while no other file of its id is on its way. */
  function tidy(path: string): void {
    const id = idOf(path);
    if ([...writing.keys()].some((one) => idOf(one) === id)) return;
    for (let dir = dirname(path); dir.startsWith(root + sep); dir = dirname(dir)) {
      try { rmdirSync(dir); } catch { return; }
    }
  }

  return (to: string, bytes: number): (() => void) | null => {
    if (writing.has(to) || !to.startsWith(root + sep)) return null;
    const held = waiting(to), used = held ? [...held.ids.values()].reduce((sum, one) => sum + one, 0) : 0;
    if (!held || used + bytes > limits.bytes || held.files + 1 > limits.files || (!held.ids.has(idOf(to)) && held.ids.size >= limits.ids)) { tidy(to); return null; }
    writing.set(to, bytes);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      writing.delete(to);
      tidy(to);
    };
  };
}
