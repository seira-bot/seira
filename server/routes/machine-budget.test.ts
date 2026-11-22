import { describe, expect, it, vi } from "vitest";

import { createMachineBudgetRoutes } from "./machine-budget.ts";
import { PASS } from "./table.ts";

const GB = 1024 ** 3;

describe("the machine budget route", () => {
  it("answers GET with the budget from the injected source", async () => {
    const json = vi.fn();
    const route = createMachineBudgetRoutes({ memory: () => ({ totalBytes: 8 * GB, freeBytes: 3 * GB }), cpus: () => 4, pressure: () => null, processes: () => null });
    await route({ method: "GET", path: "/api/internal/machine-budget", res: {} as never, json } as never);
    const text = JSON.parse(json.mock.calls[0]![2].text);
    expect(text).toMatchObject({ memoryGB: { total: 8, free: 3 }, cpus: 4, memoryPressurePercent: "unknown", suggestedWorkers: 2 });
  });
  it("answers with the room bots have under the memory limit for all bots, not the computer's free memory", async () => {
    const json = vi.fn();
    const route = createMachineBudgetRoutes({
      memory: () => ({ totalBytes: 32 * GB, freeBytes: 20 * GB }), cpus: () => 8, pressure: () => null, processes: () => null,
      botLimit: () => ({ budgetBytes: 24 * GB, usedBytes: 14 * GB }),
    });
    await route({ method: "GET", path: "/api/internal/machine-budget", res: {} as never, json } as never);
    const text = JSON.parse(json.mock.calls[0]![2].text);
    expect(text).toMatchObject({ memoryGB: { total: 24, used: 14, free: 10, sharedBy: "all bots" }, cpus: 8, suggestedWorkers: 6 });
  });
  it("passes other paths on", async () => {
    await expect(createMachineBudgetRoutes()({ method: "GET", path: "/api/internal/other" } as never)).resolves.toBe(PASS);
  });
});
