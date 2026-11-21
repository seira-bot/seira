import type { ModelSelection } from "../../contracts.ts";
import type { RoutineInput, RoutineScheduleInput } from "../../routines.ts";
import { Store } from "../../store.ts";
import { createStorePorts, type ImportPorts } from "../ports.ts";

export interface FakeRoutine {
  botId: string;
  name: string;
  prompt: string;
  enabled: boolean;
  schedule: RoutineScheduleInput;
}

export interface ImportHarness {
  store: Store;
  ports: ImportPorts;
  /** The MCP servers the import saved, keyed by name. */
  mcpServers: Record<string, unknown>;
  routines: Map<string, FakeRoutine>;
  /** Tool names that the policy refuses. */
  refused: Set<string>;
}

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

/** A real Store and real memory, skill and thread ports, with MCP config and routines held in memory. */
export function importHarness(): ImportHarness {
  const store = new Store(selection);
  const mcpServers: Record<string, unknown> = {};
  const routines = new Map<string, FakeRoutine>();
  const refused = new Set<string>();
  let next = 0;
  const ports = createStorePorts(store, {
    mcp: {
      servers: () => ({ ...mcpServers }),
      refusal: (name) => (refused.has(name) ? "refused" : null),
      persist: (saved) => {
        for (const key of Object.keys(mcpServers)) delete mcpServers[key];
        Object.assign(mcpServers, saved);
      },
    },
    routines: {
      create: (input: RoutineInput) => {
        next += 1;
        const id = `routine-${next}`;
        routines.set(id, { botId: input.botId, name: input.name, prompt: input.prompt, enabled: input.enabled ?? true, schedule: input.schedule });
        return { id };
      },
      get: (id) => {
        const routine = routines.get(id);
        return routine ? { name: routine.name, prompt: routine.prompt, enabled: routine.enabled, schedule: routine.schedule } : null;
      },
      update: (id, patch) => {
        const routine = routines.get(id);
        if (routine) routines.set(id, { ...routine, ...patch } as FakeRoutine);
        return routine ?? null;
      },
      remove: (id) => routines.delete(id),
    },
  });
  return { store, ports, mcpServers, routines, refused };
}
