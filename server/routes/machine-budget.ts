// It only reads, and shows no file names, so every conversation may ask.
import type { ServerResponse } from "node:http";

import type { json as sendJson } from "../harness/http.ts";
import { readMachineRoom, type BudgetSource } from "../machine-room.ts";
import { PASS } from "./table.ts";

const BUDGET = "/api/internal/machine-budget";

export interface MachineBudgetContext { method: string; path: string; res: ServerResponse; json: typeof sendJson }

export function createMachineBudgetRoutes(source?: BudgetSource) {
  return async (ctx: MachineBudgetContext): Promise<typeof PASS | void> => {
    if (ctx.method !== "GET" || ctx.path !== BUDGET) return PASS;
    return void ctx.json(ctx.res, 200, { text: JSON.stringify(readMachineRoom(source)) });
  };
}
