// A value that cannot be read is "unknown", never 0.
import { readFileSync } from "node:fs";

import { currentBotBudget } from "./bot-memory-budget.ts";
import { botMemoryGuard, type BotMemoryGuard } from "./bot-memory-guard.ts";
import { availableMemory, boxMemory } from "./box-memory.ts";
import { boxCpus } from "./box-cpus.ts";
import { memoryFence, type MemoryFence } from "./memory-fence.ts";
import { linuxProcessList } from "./perf/process-sampler.ts";

export type Unknown = "unknown";

const GB = 1024 ** 3;
/** One worker for each 1.5 GB of free memory: a test or build worker commonly holds that much. */
export const WORKER_GB = 1.5;
/** A process this large counts as heavy work. */
export const HEAVY_PROCESS_BYTES = GB;
const MAX_HEAVY_LISTED = 8;

/** The memory all bot work on this computer may use together, and what it uses now (null where that cannot be read). */
export interface BotLimit { budgetBytes: number; usedBytes: number | null }

interface MemoryReading { totalBytes: number; freeBytes: number }

export interface BudgetSource {
  /** The computer's memory, bytes: null where it cannot be read. */
  memory(): MemoryReading | null;
  /** The limit for all bot work together; null where nothing limits it. */
  botLimit?(): BotLimit | null;
  cpus(): number | null;
  /** Share of the last 10 seconds in which some task waited for memory, 0..100; null when this system does not say. */
  pressure(): number | null;
  /** Processes the server started, with their memory, null where the process list cannot be read. */
  processes(): { name: string; rssBytes: number }[] | null;
}

type Read = (path: string) => string | null;
const readText: Read = (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } };

/** On Linux the kernel limit counts its own use and the watchdog only the budget; on Windows and macOS the guard counts
 * the use of all bot work. */
export function currentBotLimit(input: {
  platform?: NodeJS.Platform; fence?: Pick<MemoryFence, "protection" | "budgetBytes" | "sliceCurrent">;
  guard?: Pick<BotMemoryGuard, "protection" | "budgetBytes" | "usedBytes">; budget?: () => number | null;
} = {}): BotLimit | null {
  if ((input.platform ?? process.platform) !== "linux") {
    const guard = input.guard ?? botMemoryGuard, budgetBytes = guard.protection() === "none" ? null : guard.budgetBytes();
    return budgetBytes === null ? null : { budgetBytes, usedBytes: guard.usedBytes() };
  }
  const fence = input.fence ?? memoryFence, protection = fence.protection();
  if (protection === "none") return null;
  const budgetBytes = protection === "slice" ? fence.budgetBytes() : (input.budget ?? (() => currentBotBudget()?.bytes ?? null))();
  if (budgetBytes === null) return null;
  return { budgetBytes, usedBytes: protection === "slice" ? fence.sliceCurrent() : null };
}

/** The memory bots may use: the computer's, held to the limit for all bots less what bot work uses now. */
export function botShare(machine: MemoryReading, limit: BotLimit | null): MemoryReading {
  if (limit === null) return machine;
  return {
    totalBytes: Math.min(machine.totalBytes, limit.budgetBytes),
    freeBytes: Math.min(machine.freeBytes, Math.max(0, limit.budgetBytes - (limit.usedBytes ?? 0))),
  };
}

/** The default source: what the server itself may use, as Node and the kernel report it. */
export function nodeBudgetSource(options: { platform?: NodeJS.Platform; read?: Read; serverPid?: number; list?: () => string[]; botLimit?: () => BotLimit | null } = {}): BudgetSource {
  const platform = options.platform ?? process.platform, read = options.read ?? readText, serverPid = options.serverPid ?? process.pid;
  return {
    memory() {
      const total = boxMemory().bytes, free = availableMemory();
      return total > 0 && Number.isFinite(free) && free >= 0 ? { totalBytes: total, freeBytes: Math.min(free, total) } : null;
    },
    botLimit: options.botLimit ?? (() => currentBotLimit()),
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
  /** With `sharedBy`, the memory all bots may use together: `free` is what is left of it now. */
  memoryGB: { total: number | Unknown; used: number | Unknown; free: number | Unknown; sharedBy?: "all bots" };
  cpus: number | Unknown;
  /** Percent of the last 10 seconds in which some task waited for memory. */
  memoryPressurePercent: number | Unknown;
  /** Programs over 1 GB that Seira started and that run now: a name and its memory, no arguments or file names. */
  heavyWorkRunning: { program: string; gb: number }[] | Unknown;
  suggestedWorkers: number;
}

export function readMachineRoom(source: BudgetSource = nodeBudgetSource()): MachineRoom {
  const machine = source.memory(), limit = machine ? source.botLimit?.() ?? null : null;
  const memory = machine && botShare(machine, limit), cpus = source.cpus(), pressure = source.pressure(), processes = source.processes();
  const heavy = processes === null ? null : processes
    .filter((one) => one.rssBytes > HEAVY_PROCESS_BYTES).sort((a, b) => b.rssBytes - a.rssBytes).slice(0, MAX_HEAVY_LISTED)
    .map((one) => ({ program: one.name, gb: gb(one.rssBytes) }));
  return {
    memoryGB: memory ? { total: gb(memory.totalBytes), used: gb(memory.totalBytes - memory.freeBytes), free: gb(memory.freeBytes), ...(limit ? { sharedBy: "all bots" as const } : {}) }
      : { total: "unknown", used: "unknown", free: "unknown" },
    cpus: cpus ?? "unknown",
    memoryPressurePercent: pressure ?? "unknown",
    heavyWorkRunning: heavy ?? "unknown",
    suggestedWorkers: suggestedWorkers(memory?.freeBytes ?? null, cpus),
  };
}
