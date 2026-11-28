import { describe, expect, it, vi } from "vitest";

import { createMachineBudgetRoutes } from "./machine-budget.ts";
import { PASS } from "./table.ts";

const GB = 1024 ** 3;

describe("the machine budget route", () => {
  it("answers GET with the budget from the injected source", async () => {
    const json = vi.fn();
    const route = createMachineBudgetRoutes({ source: { memory: () => ({ totalBytes: 8 * GB, freeBytes: 3 * GB }), cpus: () => 4, pressure: () => null, processes: () => null } });
    await route({ method: "GET", path: "/api/internal/machine-budget", res: {} as never, json } as never);
    const text = JSON.parse(json.mock.calls[0]![2].text);
    expect(text).toMatchObject({ memoryGB: { total: 8, free: 3 }, cpus: 4, memoryPressurePercent: "unknown", suggestedWorkers: 2 });
  });
  it("answers with the room bots have under the memory limit for all bots, not the computer's free memory", async () => {
    const json = vi.fn();
    const route = createMachineBudgetRoutes({ source: {
      memory: () => ({ totalBytes: 32 * GB, freeBytes: 20 * GB }), cpus: () => 8, pressure: () => null, processes: () => null,
      botLimit: () => ({ budgetBytes: 24 * GB, usedBytes: 14 * GB }),
    } });
    await route({ method: "GET", path: "/api/internal/machine-budget", res: {} as never, json } as never);
    const text = JSON.parse(json.mock.calls[0]![2].text);
    expect(text).toMatchObject({ memoryGB: { total: 24, used: 14, free: 10, sharedBy: "all bots" }, cpus: 8, suggestedWorkers: 6 });
  });
  it("passes other paths on", async () => {
    await expect(createMachineBudgetRoutes()({ method: "GET", path: "/api/internal/other" } as never)).resolves.toBe(PASS);
  });
  const spec = { totalMemoryBytes: 8 * GB, botMemoryBytes: 5 * GB, freeBotMemoryBytes: 4 * GB, cpus: 4, diskFreeBytes: 100.04 * GB, os: "linux" as const };
  const source = { memory: () => ({ totalBytes: 8 * GB, freeBytes: 4 * GB }), cpus: () => 4, pressure: () => null, processes: () => null };
  const ask = async (query: string, options: Record<string, unknown> = {}) => {
    const json = vi.fn();
    await createMachineBudgetRoutes({ source, spec: () => spec, botCount: () => 3, ...options })({ method: "GET", path: "/api/internal/machine-budget", res: {} as never, json, query: new URLSearchParams(query) } as never);
    return json.mock.calls[0]!;
  };
  it("adds the machine and the team to the answer", async () => {
    const [, status, body] = await ask("");
    expect(status).toBe(200);
    const text = JSON.parse(body.text);
    expect(text.machine).toEqual({ memoryGB: 8, cpus: 4, diskFreeGB: 100, os: "linux" });
    expect(text.team).toEqual({ bots: 3, botsAtOnce: 7 });
    expect(text).not.toHaveProperty("fit");
  });
  it("says unknown for what cannot be read", async () => {
    const text = JSON.parse((await ask("", { spec: () => ({ ...spec, totalMemoryBytes: null, botMemoryBytes: null, cpus: null, diskFreeBytes: null }) }))[2].text);
    expect(text.machine).toEqual({ memoryGB: "unknown", cpus: "unknown", diskFreeGB: "unknown", os: "linux" });
    expect(text.team.botsAtOnce).toBe("unknown");
  });
  it("adds the fit of a task", async () => {
    const text = JSON.parse((await ask("task=mobile_build"))[2].text);
    expect(text.fit).toMatchObject({ task: "mobile_build", verdict: "too_small", needs: { memoryGB: { min: 6, comfortable: 12 }, diskGB: 10 } });
    expect(text.fit.lighter).toBeTruthy();
    expect(JSON.parse((await ask("task=local_model&size_gb=0.5"))[2].text).fit).toMatchObject({ verdict: "ok" });
    expect(JSON.parse((await ask("task=more_bots&count=40"))[2].text).fit.verdict).toBe("too_small");
  });
  it("refuses an unknown task and a number that is not above 0", async () => {
    const [, status, body] = await ask("task=mine_bitcoin");
    expect(status).toBe(400);
    expect(body.error).toContain("task must be one of: tests");
    for (const query of ["task=build&size_gb=0", "task=build&size_gb=abc", "task=browsers&count=-1", "task=browsers&count="]) expect((await ask(query))[1]).toBe(400);
  });
});
