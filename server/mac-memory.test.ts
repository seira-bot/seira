import { describe, expect, it } from "vitest";
import { createMacMemoryReader, parseVmStat } from "./mac-memory.ts";

const APPLE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               11236.
Pages active:                            250163.
Pages inactive:                          243586.
Pages speculative:                         5894.
Pages throttled:                              0.
Pages wired down:                        128090.
Pages purgeable:                           7781.
"Translation faults":                 531062953.
Pages copy-on-write:                   10478251.
Pages zero filled:                    231233516.
Pages reactivated:                      2398610.
Pages purged:                           9990001.
File-backed pages:                       129334.
Anonymous pages:                         370309.
`;

const INTEL = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                              100000.
Pages active:                            500000.
Pages inactive:                          200000.
Pages speculative:                        10000.
Pages purgeable:                          50000.
Pages purged:                           777777.
`;

describe("parseVmStat", () => {
  it("adds free, inactive and speculative pages at 16384 bytes, but not purgeable pages", () => {
    const stat = parseVmStat(APPLE)!;
    expect(stat.pageBytes).toBe(16384);
    expect(stat.freePages).toBe(11236);
    expect(stat.inactivePages).toBe(243586);
    expect(stat.speculativePages).toBe(5894);
    expect(stat.purgeablePages).toBe(7781);
    expect(stat.availableBytes).toBe((11236 + 243586 + 5894) * 16384);
  });

  it("uses the page size of the header (4096 bytes)", () => {
    expect(parseVmStat(INTEL)!.availableBytes).toBe((100000 + 200000 + 10000) * 4096);
  });

  it("does not read Pages purged as Pages purgeable", () => {
    expect(parseVmStat(INTEL)!.purgeablePages).toBe(50000);
    const onlyPurged = "Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 10.\nPages purged: 999.\n";
    expect(parseVmStat(onlyPurged)!.purgeablePages).toBe(0);
  });

  it("returns null without the header or without Pages free", () => {
    expect(parseVmStat("Pages free: 10.\n")).toBeNull();
    expect(parseVmStat("Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages inactive: 10.\n")).toBeNull();
    expect(parseVmStat("")).toBeNull();
  });

  it("counts a missing optional field as zero", () => {
    expect(parseVmStat("Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 10.\n")!.availableBytes).toBe(10 * 4096);
  });
});

function setup(options: { runs?: Array<() => Promise<string | null>>; total?: number; fallback?: number } = {}) {
  let t = 0;
  let calls = 0;
  const runs = options.runs ?? [];
  const reader = createMacMemoryReader({
    run: () => { calls += 1; const next = runs[Math.min(calls - 1, runs.length - 1)]; return next ? next() : Promise.resolve(null); },
    total: () => options.total ?? 100 * 1024 * 1024 * 1024,
    fallbackFree: () => options.fallback ?? 111,
    now: () => t,
    maxAgeMs: 2000,
  });
  return { reader, calls: () => calls, advance: (ms: number) => { t += ms; } };
}

describe("createMacMemoryReader", () => {
  const ok = () => Promise.resolve(INTEL);
  const bytes = (100000 + 200000 + 10000) * 4096;

  it("uses the fallback before the first answer", () => {
    const { reader } = setup({ runs: [ok] });
    expect(reader.read().availableBytes).toBe(111);
  });

  it("returns the parsed value after the first refresh", async () => {
    const { reader } = setup({ runs: [ok] });
    reader.read();
    await reader.refresh();
    expect(reader.read().availableBytes).toBe(bytes);
  });

  it("serves the cache until it is older than maxAgeMs", async () => {
    const { reader, calls, advance } = setup({ runs: [ok] });
    await reader.refresh();
    expect(calls()).toBe(1);
    advance(1999);
    reader.read();
    expect(calls()).toBe(1);
    advance(1);
    expect(reader.read().availableBytes).toBe(bytes);
    expect(calls()).toBe(2);
  });

  it("never starts a second refresh while one is in flight", async () => {
    let release: (text: string | null) => void = () => undefined;
    const slow = () => new Promise<string | null>((resolve) => { release = resolve; });
    const { reader, calls } = setup({ runs: [slow] });
    reader.read();
    reader.read();
    const second = reader.refresh();
    expect(calls()).toBe(1);
    release(INTEL);
    await second;
    expect(reader.read().availableBytes).toBe(bytes);
  });

  it("uses the fallback when run fails or returns text it cannot parse", async () => {
    const { reader, advance } = setup({ runs: [ok, () => Promise.resolve(null)] });
    await reader.refresh();
    expect(reader.read().availableBytes).toBe(bytes);
    advance(2000);
    reader.read();
    await reader.refresh();
    expect(reader.read().availableBytes).toBe(111);
    const thrown = setup({ runs: [() => Promise.reject(new Error("boom"))] });
    await thrown.reader.refresh();
    expect(thrown.reader.read().availableBytes).toBe(111);
    const junk = setup({ runs: [() => Promise.resolve("not vm_stat")] });
    await junk.reader.refresh();
    expect(junk.reader.read().availableBytes).toBe(111);
  });

  it("clamps available memory to the range 0 to total", async () => {
    const small = setup({ runs: [ok], total: 1000 });
    await small.reader.refresh();
    expect(small.reader.read()).toEqual({ totalBytes: 1000, availableBytes: 1000 });
    const negative = setup({ fallback: -5, total: 1000 });
    expect(negative.reader.read().availableBytes).toBe(0);
  });
});
