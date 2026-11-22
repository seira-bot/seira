// A value that cannot be read is "unknown", never 0.
import { readFileSync } from "node:fs";

import { availableMemory, boxMemory } from "./box-memory.ts";
import { boxCpus } from "./box-cpus.ts";
import { linuxProcessList } from "./perf/process-sampler.ts";

export type Unknown = "unknown";

const GB = 1024 ** 3;
/** One worker for each 1.5 GB of free memory: a test or build worker commonly holds that much. */
export const WORKER_GB = 1.5;
/** A process this large counts as heavy work. */
export const HEAVY_PROCESS_BYTES = GB;
const MAX_HEAVY_LISTED = 8;

export interface BudgetSource {
  /** Memory bots may use, bytes: null where it cannot be read. */
  memory(): { totalBytes: number; freeBytes: number } | null;
  cpus(): number | null;
  /** Share of the last 10 seconds in which some task waited for memory, 0..100; null when this system does not say. */
  pressure(): number | null;
  /** Processes the server started, with their memory, null where the process list cannot be read. */
  processes(): { name: string; rssBytes: number }[] | null;
}

type Read = (path: string) => string | null;
const readText: Read = (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } };

/** The default source: what the server itself may use, as Node and the kernel report it. */
export function nodeBudgetSource(options: { platform?: NodeJS.Platform; read?: Read; serverPid?: number; list?: () => string[] } = {}): BudgetSource {
  const platform = options.platform ?? process.platform, read = options.read ?? readText, serverPid = options.serverPid ?? process.pid;
  return {
    memory() {
      const total = boxMemory().bytes, free = availableMemory();
      return total > 0 && Number.isFinite(free) && free >= 0 ? { totalBytes: total, freeBytes: Math.min(free, total) } : null;
    },
    cpus() { const count = boxCpus(); return count > 0 ? count : null; },
    pressure() {
      if (platform !== "linux") return null;
      const some = /^some avg10=([\d.]+)/m.exec(read("/proc/pressure/memory") ?? "")?.[1];
      return some === undefined ? null : Number(some);
    },
    processes() {
      if (platform !== "linux") return null;
      const { rows } = linuxProcessList(read, options.list);
      if (rows.length === 0) return null;
      const children = new Map<number, number[]>();
      for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
      const byPid = new Map(rows.map((row) => [row.pid, row]));
      const owned: { name: string; rssBytes: number }[] = [], seen = new Set<number>();
      const queue = [...(children.get(serverPid) ?? [])];
      for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
        if (seen.has(pid)) continue;
        seen.add(pid);
        const row = byPid.get(pid);
        if (row && row.state !== "Z") owned.push({ name: row.name, rssBytes: row.rssBytes });
        queue.push(...(children.get(pid) ?? []));
      }
      return owned;
    },
  };
}

/** Free memory divided by 1.5 GB, rounded down, at most the CPUs minus one, at least 1. With no free-memory reading the
 * answer is 1: a bot that cannot tell runs one job at a time. */
export function suggestedWorkers(freeBytes: number | null, cpus: number | null): number {
  if (freeBytes === null) return 1;
  const byMemory = Math.floor(freeBytes / GB / WORKER_GB);
  return Math.max(1, cpus === null ? byMemory : Math.min(byMemory, cpus - 1));
}

const gb = (bytes: number): number => Math.round((bytes / GB) * 10) / 10;

export interface MachineRoom {
  memoryGB: { total: number | Unknown; used: number | Unknown; free: number | Unknown };
  cpus: number | Unknown;
  /** Percent of the last 10 seconds in which some task waited for memory. */
  memoryPressurePercent: number | Unknown;
  /** Programs over 1 GB that Seira started and that run now: a name and its memory, no arguments or file names. */
  heavyWorkRunning: { program: string; gb: number }[] | Unknown;
  suggestedWorkers: number;
}

export function readMachineRoom(source: BudgetSource = nodeBudgetSource()): MachineRoom {
  const memory = source.memory(), cpus = source.cpus(), pressure = source.pressure(), processes = source.processes();
  const heavy = processes === null ? null : processes
    .filter((one) => one.rssBytes > HEAVY_PROCESS_BYTES).sort((a, b) => b.rssBytes - a.rssBytes).slice(0, MAX_HEAVY_LISTED)
    .map((one) => ({ program: one.name, gb: gb(one.rssBytes) }));
  return {
    memoryGB: memory ? { total: gb(memory.totalBytes), used: gb(memory.totalBytes - memory.freeBytes), free: gb(memory.freeBytes) }
      : { total: "unknown", used: "unknown", free: "unknown" },
    cpus: cpus ?? "unknown",
    memoryPressurePercent: pressure ?? "unknown",
    heavyWorkRunning: heavy ?? "unknown",
    suggestedWorkers: suggestedWorkers(memory?.freeBytes ?? null, cpus),
  };
}
