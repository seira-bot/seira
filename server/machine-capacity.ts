// What this computer can carry: bots at work at the same time, and whether a heavy job or a bigger team fits.
// It reads memory, processors and disk only and starts no program. A value that cannot be read is null, never 0.
import { statfsSync } from "node:fs";

import { defaultBotBudget } from "./bot-memory-budget.ts";
import { botShare, nodeBudgetSource, type BudgetSource } from "./machine-room.ts";
import { TASK_KINDS, type TaskKind } from "./machine-task-kinds.ts";

export { TASK_KINDS, type TaskKind };

const GB = 1024 ** 3;
/** One engine at work with its MCP servers. */
export const BOT_AT_WORK_BYTES = 700 * 1024 ** 2;

export type OsName = "linux" | "windows" | "macos" | "other";

export interface MachineSpec {
  totalMemoryBytes: number | null;
  botMemoryBytes: number | null;
  freeBotMemoryBytes: number | null;
  cpus: number | null;
  diskFreeBytes: number | null;
  os: OsName;
}

export type FreeDisk = (path: string) => { bavail: number | bigint; bsize: number | bigint };

const osName = (platform: NodeJS.Platform): OsName => platform === "linux" ? "linux" : platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "other";

export function readMachineSpec(input: { dataDir: string; source?: BudgetSource; statfs?: FreeDisk; platform?: NodeJS.Platform }): MachineSpec {
  const source = input.source ?? nodeBudgetSource(), platform = input.platform ?? process.platform;
  let machine: ReturnType<BudgetSource["memory"]> = null, limit: ReturnType<NonNullable<BudgetSource["botLimit"]>> = null, cpus: number | null = null;
  try { machine = source.memory(); } catch { /* not readable */ }
  try { limit = machine ? source.botLimit?.() ?? null : null; } catch { /* not readable */ }
  try { cpus = source.cpus(); } catch { /* not readable */ }
  let diskFreeBytes: number | null = null;
  try {
    const stats = (input.statfs ?? statfsSync)(input.dataDir), free = Number(stats.bavail) * Number(stats.bsize);
    diskFreeBytes = Number.isFinite(free) && free >= 0 ? free : null;
  } catch { /* not readable */ }
  const share = machine ? botShare(machine, limit) : null;
  return {
    totalMemoryBytes: machine?.totalBytes ?? null,
    botMemoryBytes: machine ? limit?.budgetBytes ?? defaultBotBudget(machine.totalBytes) : null,
    freeBotMemoryBytes: share?.freeBytes ?? null,
    cpus: cpus !== null && cpus > 0 ? cpus : null,
    diskFreeBytes,
    os: osName(platform),
  };
}

/** Bots that can work at the same time within the memory for bots; at least 1. */
export const botsAtOnce = (botMemoryBytes: number): number => Math.max(1, Math.floor(botMemoryBytes / BOT_AT_WORK_BYTES));

export type TeamVerdict = "ok" | "tight" | "over";
export interface TeamCapacity { verdict: TeamVerdict; botsAtOnce: number; botsAfter: number; spec: MachineSpec }

/** ok up to 2 times the bots that work at once, tight up to 4 times, over above that. Null when the memory for bots is unknown. */
export function teamCapacity(spec: MachineSpec, botsAfter: number): TeamCapacity | null {
  if (spec.botMemoryBytes === null) return null;
  const atOnce = botsAtOnce(spec.botMemoryBytes);
  return { verdict: botsAfter <= 2 * atOnce ? "ok" : botsAfter <= 4 * atOnce ? "tight" : "over", botsAtOnce: atOnce, botsAfter, spec };
}

export type FitVerdict = "ok" | "tight" | "too_small" | "unknown";

export interface TaskFit {
  task: TaskKind;
  verdict: FitVerdict;
  needs: { memoryGB: { min: number; comfortable: number }; diskGB: number } | null;
  lighter: string;
}

const LIGHTER: Record<TaskKind, string> = {
  tests: "Run the tests for the changed files first, with suggestedWorkers workers.",
  e2e_tests: "Run one spec file with one worker first, or run the full suite on CI or a bigger computer.",
  build: "Build one package or target at a time and close other heavy apps.",
  mobile_build: "Build on CI or a bigger computer; locally build one variant only.",
  docker: "Start only the services this task needs.",
  video: "Render a short part at a lower resolution first, one job at a time.",
  local_model: "Use a smaller model or a hosted model.",
  browsers: "Open a few pages at a time and close them before the next ones.",
  large_files: "Read the file in parts instead of all at once.",
  more_bots: "Start with the few bots needed now, give them wider roles, and spread their routines over the day.",
};

const FIXED: Partial<Record<TaskKind, [number, number, number]>> = {
  tests: [2, 4, 1], e2e_tests: [4, 8, 3], build: [2, 4, 2], mobile_build: [6, 12, 10], docker: [4, 8, 10], video: [2, 4, 5],
};

function needsOf(task: TaskKind, sizeGb?: number, count?: number): { min: number; comfortable: number; disk: number } {
  const fixed = FIXED[task];
  if (fixed) return { min: fixed[0], comfortable: fixed[1], disk: fixed[2] };
  if (task === "local_model") { const min = sizeGb === undefined ? 8 : sizeGb + 2; return { min, comfortable: min * 1.5, disk: sizeGb ?? 0 }; }
  if (task === "browsers") { const min = 0.4 * (count ?? 5); return { min, comfortable: min * 1.5, disk: 1 }; }
  if (task === "large_files") return { min: sizeGb === undefined ? 2 : sizeGb * 2, comfortable: sizeGb === undefined ? 4 : sizeGb * 3, disk: sizeGb === undefined ? 0 : sizeGb * 2 };
  return { min: 0, comfortable: 0, disk: 0 };
}

const round = (value: number) => Math.round(value * 10) / 10;

export function taskFit(spec: MachineSpec, task: TaskKind, extra: { sizeGb?: number; count?: number; botsNow?: number } = {}): TaskFit {
  const lighter = LIGHTER[task];
  if (task === "more_bots") {
    const team = teamCapacity(spec, (extra.botsNow ?? 0) + (extra.count ?? 1));
    return { task, verdict: team === null ? "unknown" : team.verdict === "ok" ? "ok" : team.verdict === "tight" ? "tight" : "too_small", needs: null, lighter };
  }
  const need = needsOf(task, extra.sizeGb, extra.count);
  const needs = { memoryGB: { min: round(need.min), comfortable: round(need.comfortable) }, diskGB: round(need.disk) };
  if (spec.botMemoryBytes === null) return { task, verdict: "unknown", needs, lighter };
  const botGb = spec.botMemoryBytes / GB, diskGb = spec.diskFreeBytes === null ? null : spec.diskFreeBytes / GB;
  if (botGb < need.min || (diskGb !== null && diskGb < need.disk)) return { task, verdict: "too_small", needs, lighter };
  const freeGb = spec.freeBotMemoryBytes === null ? null : spec.freeBotMemoryBytes / GB;
  if (botGb < need.comfortable || (freeGb !== null && freeGb < need.comfortable)) return { task, verdict: "tight", needs, lighter };
  return { task, verdict: "ok", needs, lighter };
}

const gbText = (bytes: number) => `${round(bytes / GB)}`;

export function capacityCardLine(capacity: TeamCapacity): string {
  return `This computer can run about ${capacity.botsAtOnce} bots at work at the same time. After this setup there are ${capacity.botsAfter} bots. ` +
    "Bots past that wait their turn, so their work gets slower.";
}

export function capacityHoldText(capacity: TeamCapacity): string {
  const spec = capacity.spec, size = spec.botMemoryBytes === null ? "" : ` (${gbText(spec.botMemoryBytes)} GB of memory for bots${spec.cpus === null ? "" : `, ${spec.cpus} processors`})`;
  return `Nothing was created. This computer can run about ${capacity.botsAtOnce} bots at work at the same time${size}, and this setup makes ${capacity.botsAfter} bots. ` +
    `Idle bots cost nothing, but when more than ${capacity.botsAtOnce} work at once the others wait their turn, so replies and routines get slow. ` +
    "Tell the person this in plain words, suggest a smaller setup (fewer bots with wider roles, the few they need now first, routines at different times, " +
    "or a bigger computer or server), and ask. If they still want it, call again with capacity_ok true.";
}

export function capacityNoteText(capacity: TeamCapacity): string {
  return `This computer can run about ${capacity.botsAtOnce} bots at work at the same time, and the team now has ${capacity.botsAfter} bots. ` +
    "Tell the person in one line that bots past that wait their turn when many work at once.";
}
