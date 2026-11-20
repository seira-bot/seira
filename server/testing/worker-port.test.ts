import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { freePortBlock } from "./ports.ts";
import { belowEphemeral, ephemeralFloor, forWorker, workerPort } from "./worker-port.ts";

describe("a worker's ports", () => {
  it("never meet another worker's, the port above included, whatever range each picks from", () => {
    const taken = new Map<number, string>();
    for (const worker of ["1", "2", "3", "4", "5", "6", "7", "8", "16"]) {
      for (let picked = 18_800; picked < 19_800; picked++) {
        const base = forWorker(picked, worker);
        for (const port of [base, base + 1]) {
          expect(taken.get(port) ?? worker, `port ${port}`).toBe(worker);
          taken.set(port, worker);
        }
      }
    }
  });

  it("stays near what was picked", () => {
    for (const picked of [18_800, 18_831, 19_999, 38_799]) expect(Math.abs(forWorker(picked, "4") - picked)).toBeLessThan(32);
  });

  it("is what was picked outside a worker", () => {
    expect(forWorker(19_999, "")).toBe(19_999);
    expect(forWorker(19_999, "not a worker")).toBe(19_999);
  });

  it("picks from this worker's own", () => {
    for (let i = 0; i < 200; i++) {
      const port = workerPort(18_800, 10_000);
      expect(forWorker(port), "already this worker's").toBe(port);
    }
  });

  it("stay below the ports the OS gives outgoing connections, the port above included, for every worker", () => {
    for (const floor of [32_768, 32_769, 49_152]) {
      for (let picked = 18_800; picked < 61_000; picked += 7) {
        const kept = belowEphemeral(picked, floor);
        if (picked < floor - 32) expect(kept, `port ${picked} below ${floor}`).toBe(picked);
        for (const worker of ["1", "4", "16"]) expect(forWorker(kept, worker) + 1, `port ${picked} on worker ${worker}`).toBeLessThan(floor);
      }
    }
    for (let i = 0; i < 200; i++) {
      const port = workerPort(39_000, 10_000);
      expect(port + 1).toBeLessThan(ephemeralFloor());
      expect(forWorker(port), "still this worker's").toBe(port);
    }
  });

  it("are not given to two suites of one worker that start side by side", async () => {
    const [first, second] = await Promise.all([freePortBlock([0, 1], 29_000, 640), freePortBlock([0, 1], 29_000, 640)]);
    expect(new Set([first, first + 1, second, second + 1]).size).toBe(4);
    await expect(freePortBlock([0], first + 1, 1)).rejects.toThrow(/no free port block/);
  });
});

it("leaves no suite picking a raw random port another worker could pick too", () => {
  const raw = /\d[\d_]{3,5} *\+ *Math\.floor\(Math\.random\(\) *\*/;
  const root = new URL("../../", import.meta.url);
  const offenders = ["server", "companion", "shared"].flatMap((dir) =>
    (readdirSync(new URL(dir, root), { recursive: true }) as string[])
      .filter((file) => /\.test\.[cm]?ts$/.test(file) && !file.includes("node_modules"))
      .filter((file) => raw.test(readFileSync(new URL(`${dir}/${file}`, root), "utf8")))
      .map((file) => `${dir}/${file}`));
  expect(offenders).toEqual([]);
});
