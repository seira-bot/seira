// Which departments a member of a self-hosted server sees (department-access.ts): the departments behind a sign-in
// entry, the walls that keep a limited department's bots from reaching out, and the refusals that follow.
import { entryMatches } from "../../shared/bot-access.ts";
import type { DepartmentAccessChange, DepartmentAccessView } from "../../shared/department-access.ts";
import type { VisibleSet } from "../bot-visibility.ts";
import { accessEntry, MAX_GRANTED_DEPARTMENTS, type DepartmentAccess } from "../department-access.ts";
import type { RequestAuth } from "../request-auth.ts";

export interface DepartmentAccessHostDeps {
  access: DepartmentAccess;
  /** The departments' current names, General left out. */
  sections(): readonly string[];
  /** A department's stable id; throws when the department file cannot be read. */
  keyOf(name: string): string;
  ensureKey(name: string): string;
  /** A Team Cloud or a hosted workspace: people are managed elsewhere and no grant applies. */
  elsewhere(): boolean;
  visible(auth: RequestAuth): VisibleSet;
  forgetVisibility(): void;
  closeStreams(matches: (email: string) => boolean): void;
}

export type DepartmentAccessResult = { ok: true } | { ok: false; status: number; error: string };

const NOT_AVAILABLE = "This is not available with limited access.";
const BLOCKED_PATHS = /^\/api\/(?:team-files(?:\/|$)|workspace-backup\/restore$)/;

export function createDepartmentAccessHost(deps: DepartmentAccessHostDeps) {
  let walls: ReadonlySet<string> | null = null;

  /** Current department names behind some ids. An id with no department left names nothing. */
  function namesFor(ids: readonly string[]): Set<string> {
    const names = new Set<string>();
    const wanted = new Set(ids);
    if (wanted.has("")) names.add("");
    for (const name of deps.sections()) if (wanted.has(deps.keyOf(name))) names.add(name);
    return names;
  }

  function departmentsFor(email: string | undefined): ReadonlySet<string> | null {
    if (deps.elsewhere()) return null;
    if (deps.access.unreadable) return new Set();
    const ids = deps.access.forPerson(email);
    if (!ids) return null;
    try {
      return namesFor(ids);
    } catch {
      return new Set();
    }
  }

  /** A department that any grant names. Its bots reach only bots of their own department. */
  function walled(section: string): boolean {
    if (deps.elsewhere()) return false;
    if (deps.access.unreadable) return true;
    if (!walls) {
      try {
        walls = namesFor(Object.values(deps.access.all()).flat());
      } catch {
        return true;
      }
    }
    return walls.has(section.trim());
  }

  function changed(): void {
    walls = null;
    deps.forgetVisibility();
  }

  /** A department was renamed or deleted: grants follow the id, and a deleted department leaves every grant. */
  function departmentsChanged(): void {
    try {
      const live = new Set(["", ...deps.sections().map(deps.keyOf)]);
      deps.access.keepOnly((id) => live.has(id));
    } catch {
      // The department file cannot be read: keep the grants as they are, which only narrows access.
    }
    changed();
    deps.closeStreams((email) => deps.access.forPerson(email) !== null);
  }

  function view(): DepartmentAccessView {
    const people: Record<string, string[]> = {};
    if (!deps.elsewhere() && !deps.access.unreadable) {
      for (const [entry, ids] of Object.entries(deps.access.all())) {
        try {
          people[entry] = [...namesFor(ids)];
        } catch {
          people[entry] = [];
        }
      }
    }
    return { available: !deps.elsewhere(), people, unreadable: deps.access.unreadable };
  }

  function change(body: unknown): DepartmentAccessResult {
    if (deps.elsewhere()) return { ok: false, status: 409, error: NOT_AVAILABLE };
    const { entry: raw, departments } = (body && typeof body === "object" ? body : {}) as Partial<DepartmentAccessChange>;
    const entry = accessEntry(raw);
    if (!entry) return { ok: false, status: 400, error: "Enter an email address or @domain." };
    if (departments !== null && (!Array.isArray(departments) || departments.length === 0 || departments.some((name) => typeof name !== "string"))) {
      return { ok: false, status: 400, error: "Choose at least one department." };
    }
    if (departments && new Set(departments).size > MAX_GRANTED_DEPARTMENTS) return { ok: false, status: 400, error: "Choose fewer departments." };
    let ids: string[] | null = null;
    try {
      if (departments) {
        const known = new Set(deps.sections());
        if (departments.some((name) => name !== "" && !known.has(name))) return { ok: false, status: 404, error: "No such department" };
        ids = departments.map((name) => (name === "" ? "" : deps.ensureKey(name)));
      }
      deps.access.set(entry, ids);
    } catch {
      return { ok: false, status: 409, error: "Department access cannot be changed right now." };
    }
    changed();
    deps.closeStreams((email) => entryMatches(entry, email));
    return { ok: true };
  }

  /** Why a member limited to some departments may not make this request, else null. */
  function refuses(auth: RequestAuth, path: string): string | null {
    if (auth.kind !== "session" || !BLOCKED_PATHS.test(path)) return null;
    return deps.visible(auth).limitedToDepartments ? NOT_AVAILABLE : null;
  }

  function sectionRefusal(auth: RequestAuth, section: unknown): string | null {
    return deps.visible(auth).departmentAllowed(section) ? null : "You do not have access to that department.";
  }

  return { departmentsFor, walled, view, change, refuses, sectionRefusal, departmentsChanged, changed };
}

export type DepartmentAccessHost = ReturnType<typeof createDepartmentAccessHost>;
