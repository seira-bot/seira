import { existsSync, lstatSync, readFileSync } from "node:fs";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";

const MAX_FILE_BYTES = 400_000;
export const MAX_GRANTED_DEPARTMENTS = 200;
const ENTRY = /^(?:[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+|@[^\s@,;<>"]+\.[^\s@,;<>"]+)$/;
const grantSchema = z.object({ departments: z.array(z.string().max(200)).max(MAX_GRANTED_DEPARTMENTS) }).strict();
const fileSchema = z.object({ version: z.literal(1), people: z.record(z.string(), grantSchema) }).strict();

/** An address or `@domain`, lower case; null when it is neither. */
export function accessEntry(raw: unknown): string | null {
  const entry = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return ENTRY.test(entry) ? entry : null;
}

/** Which departments each member of a self-hosted server sees, by the departments' stable ids (section-context.ts
 * memoryKeys; "" is General). A member with no entry sees the whole team. */
export class DepartmentAccess {
  private people: Record<string, string[]> = {};
  private damaged = false;
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    try {
      if (!existsSync(file)) return;
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error("unreadable");
      this.people = Object.fromEntries(Object.entries(fileSchema.parse(JSON.parse(readFileSync(file, "utf8"))).people).map(([entry, grant]) => [entry, [...grant.departments]]));
    } catch {
      this.people = {};
      this.damaged = true;
    }
  }

  /** Security invariant: when the grants cannot be read nobody can tell who was limited, so no member sees anything. */
  get unreadable(): boolean {
    return this.damaged;
  }

  /** The department ids this address is limited to; the exact address wins over its `@domain`. */
  forPerson(email: string | undefined): string[] | null {
    const address = email?.trim().toLowerCase();
    if (!address || !address.includes("@")) return null;
    const own = this.people[address] ?? this.people[address.slice(address.lastIndexOf("@"))];
    return own ? [...own] : null;
  }

  all(): Record<string, string[]> {
    return Object.fromEntries(Object.entries(this.people).map(([entry, ids]) => [entry, [...ids]]));
  }

  /** `null` gives the person the whole team again. */
  set(entry: string, ids: readonly string[] | null): void {
    if (this.damaged) throw new Error("department access cannot be read");
    const next = { ...this.people };
    if (ids === null) delete next[entry];
    else next[entry] = [...new Set(ids)];
    this.save(next);
  }

  /** Drops every department that no longer exists, so a deleted department leaves each grant. */
  keepOnly(live: (id: string) => boolean): boolean {
    if (this.damaged) return false;
    let changed = false;
    const next: Record<string, string[]> = {};
    for (const [entry, ids] of Object.entries(this.people)) {
      const kept = ids.filter(live);
      if (kept.length !== ids.length) changed = true;
      next[entry] = kept;
    }
    if (changed) this.save(next);
    return changed;
  }

  private save(next: Record<string, string[]>): void {
    writeFileAtomic(this.file, JSON.stringify({ version: 1, people: Object.fromEntries(Object.entries(next).map(([entry, ids]) => [entry, { departments: ids }])) }), { mode: 0o600 });
    this.people = next;
  }
}
