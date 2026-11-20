import type { CompanionEndpointsSnapshot } from "../../shared/wire.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const COMPANION_ENDPOINTS_PATH = "/api/companion/endpoints";

/** GET /api/companion/endpoints: every route a paired phone can use to reach this server, so it can refresh the routes
 * it stored at pairing. `request-auth.ts` lets a phone session read it. */
export function createCompanionEndpointRoutes(deps: { snapshot: () => CompanionEndpointsSnapshot }): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (path !== COMPANION_ENDPOINTS_PATH) return PASS;
    if (method !== "GET") return json(res, 405, { error: "Use GET." });
    return json(res, 200, deps.snapshot());
  };
}
