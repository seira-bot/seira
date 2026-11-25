import { existsSync, lstatSync, readFileSync } from "node:fs";
import { z } from "zod";

import type { GrantLevel } from "../shared/department-access.ts";
import { writeFileAtomic } from "./atomic.ts";

const MAX_FILE_BYTES = 4_000_000;
export const MAX_GRANTED_DEPARTMENTS = 200;
export const MAX_GRANTED_BOTS = 200;
const ENTRY = /^(?:[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+|@[^\s@,;<>"]+\.[^\s@,;<>"]+)$/;

const level = z.enum(["view", "chat"]);
const item = z.object({ id: z.string().max(200), level }).strict();
const person = z.object({
  departments: z.array(item).max(MAX_GRANTED_DEPARTMENTS),
  bots: z.array(item).max(MAX_GRANTED_BOTS),
  admitted: z.array(z.string().max(200)).max(MAX_GRANTED_BOTS).optional(),
}).strict();
const legacyFile = z.object({
  version: z.literal(1),
  people: z.record(z.string(), z.object({ departments: z.array(z.string().max(200)).max(MAX_GRANTED_DEPARTMENTS) }).strict()),
}).strict();
const currentFile = z.object({
  version: z.literal(2),
  people: z.record(z.string(), person),
}).strict();

/** One item of a grant: a department by its stable id ("" is General) or a bot by its id. */
export interface GrantedItem {
  id: string;
  level: GrantLevel;
}

/** What one sign-in entry may see. Both lists empty means nothing. */
export interface StoredGrant {
  departments: GrantedItem[];
  bots: GrantedItem[];
  /** The bots whose audience an invite of this entry widened, so a later change can undo it. */
  admitted?: string[];
}

/** An address or `@domain`, lower case; null when it is neither. */
export function accessEntry(raw: unknown): string | null {
  const entry = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return ENTRY.test(entry) ? entry : null;
}

/** An item named twice keeps the higher level. */
function collapse(items: readonly GrantedItem[]): GrantedItem[] {
  const byId = new Map<string, GrantLevel>();
  for (const { id, level: next } of items) byId.set(id, byId.get(id) === "chat" || next === "chat" ? "chat" : "view");
  return [...byId].map(([id, own]) => ({ id, level: own }));
}

const admittedOf = (list: readonly string[] | undefined): Pick<StoredGrant, "admitted"> => {
  const ids = [...new Set(list ?? [])];
  return ids.length ? { admitted: ids } : {};
};
const normal = (grant: StoredGrant): StoredGrant => ({ departments: collapse(grant.departments), bots: collapse(grant.bots), ...admittedOf(grant.admitted) });
const copy = (grant: StoredGrant): StoredGrant => ({ departments: grant.departments.map((one) => ({ ...one })), bots: grant.bots.map((one) => ({ ...one })), ...admittedOf(grant.admitted) });

function parseFile(text: string): Record<string, StoredGrant> {
  const raw: unknown = JSON.parse(text);
  const version = raw && typeof raw === "object" ? (raw as { version?: unknown }).version : undefined;
  if (version === 1) {
    const parsed = legacyFile.parse(raw);
    return Object.fromEntries(Object.entries(parsed.people).map(([entry, grant]) => [entry, normal({ departments: grant.departments.map((id) => ({ id, level: "chat" as const })), bots: [] })]));
  }
  const parsed = currentFile.parse(raw);
  return Object.fromEntries(Object.entries(parsed.people).map(([entry, grant]) => [entry, normal(grant)]));
}

/** What each member of a self-hosted server sees: departments by their stable ids (section-context.ts memoryKeys; "" is
 * General) and bots by id, each with a level. A member with no entry sees the whole team. */
export class DepartmentAccess {
  private people: Record<string, StoredGrant> = {};
  private damaged = false;
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    try {
      if (!existsSync(file)) return;
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error("unreadable");
      this.people = parseFile(readFileSync(file, "utf8"));
    } catch {
      this.people = {};
      this.damaged = true;
    }
  }

  /** Security invariant: when the grants cannot be read nobody can tell who was limited, so no member sees anything. */
  get unreadable(): boolean {
    return this.damaged;
  }

  /** The grant of this address; the exact address wins over its `@domain`. */
  forPerson(email: string | undefined): StoredGrant | null {
    const address = email?.trim().toLowerCase();
    if (!address || !address.includes("@")) return null;
    const own = this.people[address] ?? this.people[address.slice(address.lastIndexOf("@"))];
    return own ? copy(own) : null;
  }

  all(): Record<string, StoredGrant> {
    return Object.fromEntries(Object.entries(this.people).map(([entry, grant]) => [entry, copy(grant)]));
  }

  /** `null` gives the person the whole team again. */
  set(entry: string, grant: StoredGrant | null): void {
    if (this.damaged) throw new Error("department access cannot be read");
    const next = { ...this.people };
    if (grant === null) delete next[entry];
    else next[entry] = normal(grant);
    this.save(next);
  }

  /** Drops every department that no longer exists, so a deleted department leaves each grant. */
  keepOnly(live: (id: string) => boolean): boolean {
    if (this.damaged) return false;
    let changed = false;
    const next: Record<string, StoredGrant> = {};
    for (const [entry, grant] of Object.entries(this.people)) {
      const kept = grant.departments.filter((one) => live(one.id));
      if (kept.length !== grant.departments.length) changed = true;
      next[entry] = { ...grant, departments: kept };
    }
    if (changed) this.save(next);
    return changed;
  }

  /** Removes a deleted bot from every grant. A grant left with nothing stays: it shows nothing, never the whole team. */
  dropBot(botId: string): boolean {
    if (this.damaged) return false;
    let changed = false;
    const next: Record<string, StoredGrant> = {};
    for (const [entry, grant] of Object.entries(this.people)) {
      const kept = grant.bots.filter((one) => one.id !== botId);
      if (kept.length !== grant.bots.length) changed = true;
      const admitted = (grant.admitted ?? []).filter((id) => id !== botId);
      if (admitted.length !== (grant.admitted ?? []).length) changed = true;
      next[entry] = { departments: grant.departments, bots: kept, ...admittedOf(admitted) };
    }
    if (changed) this.save(next);
    return changed;
  }

  private save(next: Record<string, StoredGrant>): void {
    const text = JSON.stringify({ version: 2, people: next });
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error("department access is too large");
    writeFileAtomic(this.file, text, { mode: 0o600 });
    this.people = next;
  }
}
