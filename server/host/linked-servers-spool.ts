// How many file bytes, and for how many hand-offs, one linked server may keep waiting here before the frames that use
// them arrive. Its files go to the spool of its own link: one folder for each hand-off id, then one for each way.
import { readdirSync, rmdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { SPOOL_MAX_BYTES } from "../bot-link/link.ts";
import { ADMIT } from "./linked-servers-admit.ts";

export interface SpoolLimits {
  bytes: number;
  /** Hand-off ids with files waiting: the hand-offs a link may have open here, and as many results. */
  ids: number;
}

export const SPOOL_ROOM: SpoolLimits = { bytes: SPOOL_MAX_BYTES, ids: 2 * ADMIT.open };

/** Room in the spool at `root` for one file about to arrive: a release to call when its write ends, or null when the file
 * would take the spool past `limits`. */
export function createSpoolRoom(root: string, limits: SpoolLimits = SPOOL_ROOM) {
  const writing = new Map<string, number>();
  const idOf = (path: string) => relative(root, path).split(sep)[0] ?? "";

  /** The bytes waiting for each id: files written and files being written. `to` is about to be written again. */
  function waiting(to: string): Map<string, number> {
    const ids = new Map<string, number>();
    const add = (id: string, bytes: number) => ids.set(id, (ids.get(id) ?? 0) + bytes);
    let names: string[] = [];
    try { names = readdirSync(root); } catch { /* no file came yet */ }
    for (const name of names) {
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) walk(path);
          else if (!writing.has(path)) add(name, path === to ? 0 : statSync(path).size);
        }
      };
      try { walk(join(root, name)); } catch { /* removed while read */ }
    }
    for (const [path, bytes] of writing) add(idOf(path), bytes);
    return ids;
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
    const ids = waiting(to), used = [...ids.values()].reduce((sum, one) => sum + one, 0);
    if (used + bytes > limits.bytes || (!ids.has(idOf(to)) && ids.size >= limits.ids)) { tidy(to); return null; }
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
