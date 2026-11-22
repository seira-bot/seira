import type { DepartmentAccessHost } from "../host/department-access-host.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createDepartmentAccessRoutes(host: Pick<DepartmentAccessHost, "view" | "change">): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/department-access" || (method !== "GET" && method !== "PUT")) return PASS;
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "Only an admin can change who sees which department." });
    if (method === "GET") return json(res, 200, host.view());
    const result = host.change(await readBody(req));
    if (!result.ok) return json(res, result.status, { error: result.error });
    return json(res, 200, host.view());
  };
}
