// Which files under a folder hold a piece of text: the check behind "this secret reaches nothing but its own file".
// The folder is a running server's data folder, and the server writes there while the walk runs: server/atomic.ts writes
// <file>.<pid>.<uuid>.tmp and renames it over <file>. A name that was listed may be gone before it is read.
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const MAX_FILE_BYTES = 20_000_000;
/** The name server/atomic.ts gives the file it writes before the rename. */
const ATOMIC_TEMPORARY = /^(.+)\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u;

export interface FilesHoldingOptions {
  /** True for a file or folder the caller does not count. Runs after the folder was listed and before its entry is read. */
  skip?: (path: string, name: string) => boolean;
  /** False leaves a link alone: it is neither read nor walked into, so a link out of the folder reaches nothing outside it.
   * Default true. */
  followLinks?: boolean;
}

/** What the walk does with a name that is gone by the time it looks: a file or folder that no longer exists holds nothing. */
function vanished(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Paths under `root`, relative to it and sorted, of the files that hold `text`. The temp file of an atomic write counts as
 * the file it becomes (a copy of a file beside it holds nothing the file does not hold) and is named once. */
export function filesHolding(root: string, text: string, options: FilesHoldingOptions = {}): string[] {
  const found = new Set<string>();
  const look = options.followLinks === false ? lstatSync : statSync;
  const walk = (dir: string): void => {
    let names: string[];
    try { names = readdirSync(dir); } catch (error) { if (vanished(error)) return; throw error; }
    for (const name of names) {
      const path = join(dir, name);
      if (options.skip?.(path, name)) continue;
      try {
        const stat = look(path);
        if (stat.isDirectory()) walk(path);
        else if (stat.isFile() && stat.size < MAX_FILE_BYTES && readFileSync(path).includes(text)) found.add(relative(root, join(dir, ATOMIC_TEMPORARY.exec(name)?.[1] ?? name)));
      } catch (error) {
        if (!vanished(error)) throw error;
      }
    }
  };
  walk(root);
  return [...found].sort();
}
