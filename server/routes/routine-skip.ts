import type { RequestAuth } from "../request-auth.ts";
import { routineSkipBody, setOccurrenceSkip, type SkipHost } from "../routine-skip-occurrence.ts";
import type { Routine } from "../routines.ts";
import { PASS, type RouteHandler } from "./table.ts";

const SKIP = /^\/api\/routines\/([\w-]+)\/skip$/;

export interface RoutineSkipRouteDeps {
  routines: () => SkipHost | null | undefined;
  refusal: (auth: RequestAuth, routine: Routine) => { status: number; error: string } | null;
  forViewer: (auth: RequestAuth, routine: Routine) => Routine;
  now?: () => number;
}

export function createRoutineSkipRoutes(deps: RoutineSkipRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const match = method === "POST" ? SKIP.exec(path) : null, routines = match ? deps.routines() : null;
    if (!match || !routines) return PASS;
    const parsed = routineSkipBody.safeParse(await readBody(req));
    if (!parsed.success) return void json(res, 400, { error: "Send the time to skip and whether to skip it." });
    const existing = routines.listRoutines().find((routine) => routine.id === match[1]);
    const refused = existing ? deps.refusal(auth, existing) : null;
    if (refused) return void json(res, refused.status, { error: refused.error });
    const result = setOccurrenceSkip(routines, match[1], parsed.data.at, parsed.data.skip, (deps.now ?? Date.now)());
    if (!result) return void json(res, 404, { error: "no such routine" });
    if ("error" in result) return void json(res, 400, { error: result.error });
    json(res, 200, { routine: deps.forViewer(auth, result.routine) });
  };
}
