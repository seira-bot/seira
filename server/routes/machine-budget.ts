// It only reads, and shows no file names, so every conversation may ask.
import type { ServerResponse } from "node:http";

import type { json as sendJson } from "../harness/http.ts";
import { botsAtOnce, readMachineSpec, taskFit, TASK_KINDS, type MachineSpec, type TaskKind } from "../machine-capacity.ts";
import { readMachineRoom, type BudgetSource } from "../machine-room.ts";
import { PASS } from "./table.ts";

const BUDGET = "/api/internal/machine-budget";
const GB = 1024 ** 3;

export interface MachineBudgetContext { method: string; path: string; res: ServerResponse; json: typeof sendJson; query?: URLSearchParams }

export interface MachineBudgetOptions {
  source?: BudgetSource;
  dataDir?: string;
  botCount?: () => number;
  spec?: () => MachineSpec;
}

const gb = (bytes: number | null) => bytes === null ? "unknown" : Math.round((bytes / GB) * 10) / 10;

function positive(value: string | null): number | undefined | "bad" {
  if (value === null) return undefined;
  const number = Number(value);
  return value.trim() !== "" && Number.isFinite(number) && number > 0 ? number : "bad";
}

export function createMachineBudgetRoutes(options: MachineBudgetOptions = {}) {
  return async (ctx: MachineBudgetContext): Promise<typeof PASS | void> => {
    if (ctx.method !== "GET" || ctx.path !== BUDGET) return PASS;
    const task = ctx.query?.get("task") ?? undefined, sizeGb = positive(ctx.query?.get("size_gb") ?? null), count = positive(ctx.query?.get("count") ?? null);
    if (task !== undefined && !(TASK_KINDS as readonly string[]).includes(task)) return void ctx.json(ctx.res, 400, { error: `task must be one of: ${TASK_KINDS.join(", ")}` });
    if (sizeGb === "bad" || count === "bad") return void ctx.json(ctx.res, 400, { error: "size_gb and count must be numbers above 0" });
    const spec = options.spec?.() ?? readMachineSpec({ dataDir: options.dataDir ?? ".", source: options.source }), bots = options.botCount?.() ?? 0;
    const body = {
      ...readMachineRoom(options.source),
      machine: { memoryGB: gb(spec.totalMemoryBytes), cpus: spec.cpus ?? "unknown", diskFreeGB: gb(spec.diskFreeBytes), os: spec.os },
      team: { bots, botsAtOnce: spec.botMemoryBytes === null ? "unknown" : botsAtOnce(spec.botMemoryBytes) },
      ...(task ? { fit: taskFit(spec, task as TaskKind, { sizeGb, count, botsNow: bots }) } : {}),
    };
    return void ctx.json(ctx.res, 200, { text: JSON.stringify(body) });
  };
}
