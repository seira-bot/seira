import type { DepartmentFolders } from "../department-folders.ts";
import { validateFolderAccess } from "../folder-access.ts";
import type { Store } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export type FolderEnforcement = "box" | "limited" | "ai";

export const FOLDER_ACCESS_SET_ELSEWHERE = "Folder access is set on the computer where Seira runs.";

export interface DepartmentFolderRouteDeps {
  store: Pick<Store, "sections">;
  folders: DepartmentFolders;
  dataDir: string;
  home: string;
  /** True on a Team Cloud or a hosted workspace, where folders are not set from here. */
  setElsewhere(): boolean;
  /** What holds a limited bot to its folders: the bot box for every bot, the box for limited bots only, or the AI's own
   * file tools. */
  enforcement(): FolderEnforcement;
}

export function createDepartmentFolderRoutes(deps: DepartmentFolderRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    if (path !== "/api/department-folders" || (method !== "GET" && method !== "PUT")) return PASS;
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "Only an admin can change folder access." });
    if (method === "GET") return json(res, 200, { departments: deps.folders.all(), enforcement: deps.enforcement(), setHere: !deps.setElsewhere() });
    if (deps.setElsewhere()) return json(res, 409, { error: FOLDER_ACCESS_SET_ELSEWHERE });
    const section = url.searchParams.get("section")?.trim();
    if (!section || !deps.store.sections.includes(section)) return json(res, 404, { error: "No such department" });
    const body = await readBody(req);
    if (body === null) {
      deps.folders.set(section, null);
      return json(res, 200, { access: null });
    }
    const checked = validateFolderAccess(body, { dataDir: deps.dataDir, home: deps.home });
    if (!checked.ok) return json(res, 400, { error: checked.message, refusal: checked.refusal, path: checked.path });
    deps.folders.set(section, checked.value);
    return json(res, 200, { access: checked.value.limited || checked.value.folders.length ? checked.value : null });
  };
}
