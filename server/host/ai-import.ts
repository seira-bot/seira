import { homedir } from "node:os";
import { join } from "node:path";

import { AiImportJobs } from "../ai-import/job.ts";
import { locateLocalSources } from "../ai-import/locate.ts";
import { createStorePorts, type StorePortDeps } from "../ai-import/ports.ts";
import type { RoutineManager } from "../routines.ts";
import { createAiImportRoutes } from "../routes/ai-import.ts";
import type { RouteHandler } from "../routes/table.ts";
import type { Store } from "../store.ts";

export interface AiImportHostDeps {
  dataDir: string;
  store: Store;
  mcp: StorePortDeps["mcp"];
  routines: () => RoutineManager | null;
  broadcast(payload: Record<string, unknown>, options: { adminOnly: true }): void;
  local: boolean;
}

export function createAiImportHost(deps: AiImportHostDeps): { jobs: AiImportJobs; routes: RouteHandler } {
  const manager = () => {
    const routines = deps.routines();
    if (!routines) throw new Error("Routines are not ready");
    return routines;
  };
  const jobs = new AiImportJobs({
    dir: join(deps.dataDir, "ai-import"),
    ports: createStorePorts(deps.store, {
      mcp: deps.mcp,
      routines: {
        create: (input) => manager().create(input),
        get: (id) => {
          const routine = deps.routines()?.listRoutines().find((item) => item.id === id);
          return routine ? { name: routine.name, prompt: routine.prompt, enabled: routine.enabled, schedule: routine.schedule } : null;
        },
        update: (id, patch) => manager().update(id, patch),
        remove: (id) => manager().remove(id),
      },
    }),
    broadcast: (event) => deps.broadcast({ kind: event.type, ...event }, { adminOnly: true }),
    locate: () => locateLocalSources(process.env, homedir()),
  });
  jobs.start();
  return { jobs, routes: createAiImportRoutes({ jobs, local: deps.local }) };
}
