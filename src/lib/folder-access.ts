import { useCallback, useEffect, useState } from "react";

import { api } from "@/state/store";
import type { WireFolderAccess, WireFolderGrant } from "../../shared/wire";

export type FolderAccess = WireFolderAccess;
export type FolderGrant = WireFolderGrant;

export interface DepartmentFolders {
  departments: Record<string, FolderAccess>;
  /** "limited": the bot box holds only bots limited to chosen folders. */
  enforcement: "box" | "limited" | "ai";
  /** `no-bwrap`: commands are not held to the folders because this computer has no bubblewrap. */
  boxMissing?: "no-bwrap" | null;
  setHere: boolean;
}

/** Nothing set is the same as no setting: the server stores `null`. */
export function folderAccessOrNull(access: FolderAccess | null | undefined): FolderAccess | null {
  return access && (access.limited || access.folders.length > 0) ? access : null;
}

export interface ShownFolder extends FolderGrant {
  /** The department that gave this folder, when it did. */
  from?: string;
}

/** A bot uses its department's folders plus its own; its own entry for the same path replaces the department's. */
export function shownFolders(own: FolderAccess | null | undefined, department?: { name: string; access: FolderAccess | undefined }): ShownFolder[] {
  const mine = own?.folders ?? [];
  const taken = new Set(mine.map((folder) => folder.path));
  const inherited = (department?.access?.folders ?? []).filter((folder) => !taken.has(folder.path)).map((folder) => ({ ...folder, from: department!.name }));
  return [...inherited, ...mine];
}

/** The bot is limited when it or its department turns "Only chosen folders" on. */
export function limitedBy(own: FolderAccess | null | undefined, department?: { name: string; access: FolderAccess | undefined }): "bot" | "department" | null {
  if (department?.access?.limited) return "department";
  return own?.limited ? "bot" : null;
}

export function useDepartmentFolders(enabled: boolean) {
  const [data, setData] = useState<DepartmentFolders | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void api<DepartmentFolders>("/api/department-folders")
      .then((result) => { if (!cancelled) setData(result); })
      .catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, [enabled]);

  const setDepartment = useCallback(async (section: string, access: FolderAccess | null) => {
    const result = await api<{ access: FolderAccess | null }>(`/api/department-folders?section=${encodeURIComponent(section)}`, {
      method: "PUT",
      body: JSON.stringify(access),
    });
    setData((current) => {
      if (!current) return current;
      const departments = { ...current.departments };
      if (result.access) departments[section] = result.access;
      else delete departments[section];
      return { ...current, departments };
    });
  }, []);

  return { data, setDepartment };
}
