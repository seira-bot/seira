// The memory limit for bots on Windows and macOS. On Windows one job object, which `seira-job-fence.exe hold` owns, holds
// all bot work under the budget: each engine starts in it through `seira-job-fence.exe --`. Where that helper is missing
// or fails, and on macOS, a watchdog stops the largest process of the bots' trees once they go over the budget.
import { freemem, totalmem } from "node:os";
import { join } from "node:path";

import { currentBotBudget } from "./bot-memory-budget.ts";
import { dataHome } from "./data-dir.ts";
import { jobBaseName, jobFenceArgv, jobFenceEnv, jobFencePath, startJobHold, type JobFenceEvent, type JobHold, type JobHoldOptions } from "./job-fence.ts";
import { createMacMemoryReader } from "./mac-memory.ts";
import { memoryLimitWanted, type FencedSpawn, type FenceView } from "./memory-fence.ts";
import type { FootprintOwner } from "./perf/bot-footprint.ts";
import type { ProcessRow } from "./perf/process-buckets.ts";
import { psProcessList } from "./perf/process-sampler.ts";
import { windowsProcessList } from "./perf/windows-process-list.ts";
import { createTreeMemoryWatchdog, type TreeMemoryStop, type TreeMemoryWatchdogOptions } from "./tree-memory-watchdog.ts";

export type GuardProtection = "job" | "watchdog" | "none";

const MB = 1024 * 1024;
/** The job's numbers are asked for again after this long. */
const STATS_EVERY_MS = 1_000;

export interface MachineMemory { totalBytes: number; availableBytes: number }

export interface GuardDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** The budget in bytes now; null for no protection. */
  budget(): number | null;
  helper(): string | null;
  startHold(options: JobHoldOptions): Promise<JobHold | null>;
  list(): Promise<readonly ProcessRow[] | null>;
  machine(): MachineMemory;
  watchdog(options: TreeMemoryWatchdogOptions): { start(): void; stop(): void; used(): number | null };
  dataDir(): string;
  now(): number;
  log(line: string): void;
}

const macMemory = createMacMemoryReader();

const realDeps = (): GuardDeps => ({
  env: process.env,
  platform: process.platform,
  budget: () => currentBotBudget()?.bytes ?? null,
  helper: () => jobFencePath(),
  startHold: startJobHold,
  list: async () => (await (process.platform === "win32" ? windowsProcessList() : psProcessList()))?.rows ?? null,
  machine: () => process.platform === "darwin" ? macMemory.read() : { totalBytes: totalmem(), availableBytes: freemem() },
  watchdog: createTreeMemoryWatchdog,
  dataDir: () => process.env.SEIRA_DATA_DIR || join(dataHome(), ".seira"),
  now: () => Date.now(),
  log: (line) => console.warn(`memory: ${line}`),
});

const liveEngine = (owners: readonly FootprintOwner[]) => owners.some((owner) => owner.kind === "engine" && !owner.exited);

export class BotMemoryGuard implements FenceView {
  readonly #deps: GuardDeps;
  #mode: GuardProtection = "none";
  #started = false;
  #helper: string | null = null;
  #hold: JobHold | null = null;
  #owners: () => readonly FootprintOwner[] = () => [];
  #dog: ReturnType<GuardDeps["watchdog"]> | null = null;
  #stops = 0;
  /** Stops by the process the server started: the helper on Windows, else the engine. */
  readonly #stopsBy = new Map<number, number>();
  #jobBytes: number | null = null;
  #askedAt = -Infinity;

  constructor(deps: Partial<GuardDeps> = {}) { this.#deps = { ...realDeps(), ...deps }; }

  wanted(): boolean { return (this.#deps.platform === "win32" || this.#deps.platform === "darwin") && memoryLimitWanted(this.#deps.env); }

  protection(): GuardProtection { return this.#mode; }

  active(): boolean { return this.#mode !== "none"; }

  /** Starts the job on Windows, or the watchdog, once. Resolves when the protection is in force. */
  async start(owners: () => readonly FootprintOwner[]): Promise<void> {
    if (this.#started || !this.wanted()) return;
    this.#started = true;
    this.#owners = owners;
    if (this.#deps.platform === "win32") {
      const helper = this.#deps.helper(), budget = this.#deps.budget();
      const hold = helper && budget !== null
        ? await this.#deps.startHold({ helper, base: jobBaseName(this.#deps.dataDir()), limitBytes: budget, onEvent: (event) => this.#event(event), onExit: () => this.#holdEnded() })
        : null;
      if (hold) {
        this.#helper = helper;
        this.#hold = hold;
        this.#mode = "job";
        this.#deps.log(`all bot work may use up to ${Math.round(hold.limitBytes() / MB)} MB together; a job object holds it to that limit`);
        return;
      }
      this.#deps.log(helper ? "the memory helper for bots did not start" : "the memory helper for bots is missing");
    }
    this.#watch();
  }

  #watch(): void {
    this.#mode = "watchdog";
    this.#dog = this.#deps.watchdog({
      list: () => liveEngine(this.#owners()) ? this.#deps.list() : null,
      owners: () => this.#owners(),
      budgetBytes: () => this.#deps.budget(),
      available: () => this.#deps.machine().availableBytes,
      onStop: (stop) => this.#watchdogStopped(stop),
    });
    this.#dog.start();
    this.#deps.log("a watchdog keeps all bot work under the memory limit for bots");
  }

  #holdEnded(): void {
    if (!this.#hold) return;
    this.#hold = null;
    this.#jobBytes = null;
    this.#deps.log("the memory helper for bots stopped; a watchdog keeps bot work under the limit instead");
    this.#watch();
  }

  #counted(by: number | null): void {
    this.#stops += 1;
    if (by !== null && by > 0) this.#stopsBy.set(by, (this.#stopsBy.get(by) ?? 0) + 1);
  }

  #event(event: JobFenceEvent): void {
    if (event.event === "stats") this.#jobBytes = event.jobBytes;
    else if (event.event === "memory-stop") {
      this.#counted(event.helper);
      this.#deps.log(`stopped ${event.name} (${Math.round(event.bytes / MB)} MB) at the memory limit for bots: ${Math.round(event.jobBytes / MB)} of ${Math.round(event.limitBytes / MB)} MB in use`);
    } else if (event.event === "error") this.#deps.log(`the memory helper for bots could not ${event.step} (error ${event.code})`);
  }

  #watchdogStopped(stop: TreeMemoryStop): void {
    this.#counted(stop.root);
    this.#deps.log(`stopped ${stop.name} (${Math.round(stop.bytes / MB)} MB): bot work used ${Math.round(stop.totalBytes / MB)} of ${Math.round(stop.budgetBytes / MB)} MB`);
  }

  /** The command that starts `command` in the bots' job on Windows; null where it starts as is. Throws EINVAL for a batch
   * file, as Node's own spawn does. */
  argv(command: string, args: readonly string[], env: NodeJS.ProcessEnv): FencedSpawn | null {
    const hold = this.#hold;
    if (this.#mode !== "job" || !hold?.alive() || !this.#helper) return null;
    const budget = this.#deps.budget();
    if (budget !== null) hold.setLimit(budget);
    return { ...jobFenceArgv(this.#helper, command, args), env: jobFenceEnv(env, hold.job) };
  }

  /** The memory all bot work uses now, as last read; null where it is not known. */
  usedBytes(): number | null {
    if (this.#mode === "watchdog") return this.#dog?.used() ?? null;
    if (this.#mode !== "job" || !this.#hold) return null;
    const at = this.#deps.now();
    if (at - this.#askedAt >= STATS_EVERY_MS) { this.#askedAt = at; this.#hold.stats(); }
    return this.#jobBytes;
  }

  machine(): MachineMemory { return this.#deps.machine(); }

  budgetBytes(): number | null { return this.#deps.budget(); }

  sliceKills(): number | null { return this.active() ? this.#stops : null; }

  scopeKills(pid: number): number | null { return this.active() ? this.#stopsBy.get(pid) ?? 0 : null; }
}

export const botMemoryGuard = new BotMemoryGuard();
