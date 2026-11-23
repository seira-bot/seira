import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { ImportEntry, ImportFiles } from "./reader.ts";

/** Lists regular files only: symlinks and other special files are left out. */
export async function folderFiles(root: string): Promise<ImportFiles> {
  const entries: ImportEntry[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) await walk(join(dir, item.name), name);
      else if (item.isFile()) entries.push({ name, size: (await lstat(join(dir, item.name))).size });
    }
  };
  await walk(root, "");
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const known = new Set(entries.map((entry) => entry.name));
  return {
    entries,
    open: async (name: string): Promise<Readable> => {
      if (!known.has(name)) throw new Error(`No entry named ${name}`);
      return createReadStream(join(root, ...name.split("/")));
    },
  };
}
