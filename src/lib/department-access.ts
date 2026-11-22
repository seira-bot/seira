import { api } from "@/state/store";
import type { DepartmentAccessView } from "../../shared/department-access";

export type { DepartmentAccessView };

export interface DepartmentChoices {
  access: DepartmentAccessView;
  /** The departments' names, General left out. */
  departments: string[];
  /** The departments (General as "") that hold their bots to chosen folders. */
  limited: Set<string>;
}

/** Null where the server keeps no such choice (people are managed elsewhere), or the owner cannot read it. */
export async function loadDepartmentChoices(): Promise<DepartmentChoices | null> {
  try {
    const [access, sections, folders] = await Promise.all([
      api<DepartmentAccessView>("/api/department-access"),
      api<{ sections?: unknown }>("/api/sidebar-sections"),
      api<{ departments?: Record<string, { limited?: boolean }> }>("/api/department-folders").catch((): { departments?: Record<string, { limited?: boolean }> } => ({ departments: {} })),
    ]);
    if (!access?.available) return null;
    const departments = Array.isArray(sections?.sections) ? sections.sections.filter((name): name is string => typeof name === "string") : [];
    const limited = new Set(Object.entries(folders?.departments ?? {}).filter(([, entry]) => entry?.limited === true).map(([name]) => name));
    return { access, departments, limited };
  } catch {
    return null;
  }
}

export async function saveDepartmentAccess(entry: string, departments: string[] | null): Promise<void> {
  await api("/api/department-access", { method: "PUT", body: JSON.stringify({ entry, departments }) });
}

/** The chosen departments whose bots are not held to chosen folders: they can still read files outside them. */
export function openFolderDepartments(chosen: readonly string[], limited: ReadonlySet<string>): string[] {
  return chosen.filter((name) => !limited.has(name));
}

/** The departments a sign-in entry is limited to: its own entry, else its `@domain`'s, as the server decides. */
export function grantFor(people: Readonly<Record<string, string[]>>, entry: string): string[] | undefined {
  return people[entry] ?? (entry.startsWith("@") ? undefined : people[entry.slice(entry.lastIndexOf("@"))]);
}
