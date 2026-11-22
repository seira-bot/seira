import { existsSync, lstatSync, readFileSync } from "node:fs";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { type FolderAccess, folderAccessSchema } from "./folder-access.ts";
import { sectionKey } from "./store.ts";

const MAX_FILE_BYTES = 200_000;
const fileSchema = z.object({ version: z.literal(1), departments: z.record(z.string(), folderAccessSchema) }).strict();

const empty = (access: FolderAccess | null | undefined): boolean => !access || (!access.limited && access.folders.length === 0);
const copy = (access: FolderAccess): FolderAccess => ({ limited: access.limited, folders: access.folders.map(folder => ({ ...folder })) });

export class DepartmentFolders {
  private departments: Record<string, FolderAccess> = {};
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    try {
      if (!existsSync(file)) return;
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return;
      this.departments = fileSchema.parse(JSON.parse(readFileSync(file, "utf8"))).departments;
    } catch {
      this.departments = {};
    }
  }

  get(section: string): FolderAccess | undefined {
    const access = this.departments[sectionKey(section)];
    return access ? copy(access) : undefined;
  }

  all(): Record<string, FolderAccess> {
    return Object.fromEntries(Object.entries(this.departments).map(([name, access]) => [name, copy(access)]));
  }

  set(section: string, access: FolderAccess | null): void {
    const next = { ...this.departments };
    if (empty(access)) delete next[sectionKey(section)];
    else next[sectionKey(section)] = copy(access!);
    this.save(next);
  }

  rename(from: string, to: string): void {
    const source = sectionKey(from);
    const access = this.departments[source];
    if (!access || source === sectionKey(to)) return;
    const next = { ...this.departments };
    delete next[source];
    next[sectionKey(to)] = access;
    this.save(next);
  }

  remove(section: string): void {
    if (this.departments[sectionKey(section)] === undefined) return;
    const next = { ...this.departments };
    delete next[sectionKey(section)];
    this.save(next);
  }

  private save(next: Record<string, FolderAccess>): void {
    writeFileAtomic(this.file, JSON.stringify({ version: 1, departments: next }), { mode: 0o600 });
    this.departments = next;
  }
}
