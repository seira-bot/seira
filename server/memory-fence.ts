// All bot work on a Linux computer runs under one systemd user slice with a kernel memory limit. Each engine gets its own
// scope under that slice, so the kernel stops the program that goes over the limit and nothing else.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";

import { currentBotBudget, gbText } from "./bot-memory-budget.ts";
import { noticeFailure } from "./chat-notices.ts";
import { newEventId, type ProviderAdapter, type ProviderInstance, type RuntimeEvent, type RuntimeEventListener } from "./contracts.ts";
import { dataHome } from "./data-dir.ts";
import { inactiveFileBytes } from "./process-limits.ts";

export const FENCE_ENV = "SEIRA_BOT_MEMORY_FENCE";
/** Only folders that root owns: a bot may write to a folder in the server's PATH, and a program it plants there would run
 * outside the box. */
const SYSTEM_BIN_DIRS = ["/usr/bin", "/bin", "/run/current-system/sw/bin"];
/** The user manager is reached through these two variables. */
const BUS_VARS = ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] as const;
export const OOM_POLL_MS = 1_000;
const PROBE_TIMEOUT_MS = 2_000;
const CHECK_TIMEOUT_MS = 1_000;
const CHECK_EVERY_MS = 10_000;
/** The kernel rounds a limit to its page size. */
const LIMIT_SLACK_BYTES = 1024 * 1024;

const defaultDataDir = () => process.env.SEIRA_DATA_DIR || join(dataHome(), ".seira");

/** One slice per data folder, so an installed app and a development copy never change each other's limit. A dash in a slice
 * name makes a nested slice, so the name uses underscores. */
export function fenceSliceName(dataDir: string = defaultDataDir()): string {
  return `seira_bots_${createHash("sha256").update(resolve(dataDir)).digest("hex").slice(0, 10)}.slice`;
}

/** Off Linux never; `off` or a budget of `off`/0 never; `on` always; else only in the desktop app's server. */
export function fenceWanted(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "linux") return false;
  const fence = env[FENCE_ENV]?.trim().toLowerCase();
  if (fence === "off") return false;
  const budget = env.SEIRA_BOT_MEMORY_MAX_MB?.trim().toLowerCase();
  if (budget === "off" || budget === "0") return false;
  if (fence === "on") return true;
  return env.SEIRA_DESKTOP_PARENT === "1";
}

/** One CPU stays free for the person's own programs. */
export function sliceProperties(budgetBytes: number, cpus: number): string[] {
  return [`MemoryMax=${Math.floor(budgetBytes)}`, "MemorySwapMax=0", `CPUQuota=${Math.max(1, Math.floor(cpus) - 1) * 100}%`];
}

/** A program in the system folders, never in PATH. */
export function findProgram(name: string, exists: (path: string) => boolean = existsSync): string | null {
  for (const dir of SYSTEM_BIN_DIRS) { const path = join(dir, name); if (exists(path)) return path; }
  return null;
}

export interface FencedSpawn { command: string; args: string[]; env: NodeJS.ProcessEnv }

export function fenceArgv(input: {
  systemdRun: string; envProgram: string; slice: string; oomPolicy: boolean; command: string; args: readonly string[]; env: NodeJS.ProcessEnv; processEnv?: NodeJS.ProcessEnv;
}): FencedSpawn {
  const processEnv = input.processEnv ?? process.env;
  const env = { ...input.env };
  const added: string[] = [];
  for (const name of BUS_VARS) {
    const value = processEnv[name];
    if (env[name] === undefined && value !== undefined) { env[name] = value; added.push(name); }
  }
  const strip = added.length ? [input.envProgram, ...added.flatMap((name) => ["-u", name]), "--"] : [];
  return {
    command: input.systemdRun,
    args: ["--user", "--scope", "--quiet", "--collect", `--slice=${input.slice}`, ...(input.oomPolicy ? ["-p", "OOMPolicy=continue"] : []), "--", ...strip, input.command, ...input.args],
    env,
  };
}

/** The English words a bot reads when one of its programs ran out of memory. */
export const fenceOomBotText = (gb: string): string =>
  `A command in this turn ran out of memory and the system stopped it. All bot work on this computer may use ${gb} GB together. `
  + "Run it again with fewer parallel workers (for example --maxWorkers=2 or -j2), or on a smaller part of the work.";

const killsOf = (text: string | null): number | null => { const found = text === null ? null : /^oom_kill (\d+)$/m.exec(text); return found ? Number(found[1]) : null; };

export interface FenceDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  run(file: string, args: readonly string[], timeoutMs?: number): { status: number | null; stdout: string };
  now(): number;
  read(path: string): string | null;
  exists(path: string): boolean;
  cpus(): number;
  /** The budget in bytes now; null for no protection. */
  budget(): number | null;
  slice(): string;
  log(line: string): void;
}

const realDeps: FenceDeps = {
  get env() { return process.env; },
  platform: process.platform,
  run: (file, args, timeoutMs = PROBE_TIMEOUT_MS) => { const done = spawnSync(file, [...args], { encoding: "utf8", timeout: timeoutMs }); return { status: done.status, stdout: done.stdout ?? "" }; },
  read: (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } },
  exists: existsSync,
  now: () => Date.now(),
  cpus: () => availableParallelism(),
  budget: () => currentBotBudget()?.bytes ?? null,
  slice: () => fenceSliceName(),
  log: (line) => console.warn(`memory: ${line}`),
};

interface Probe { ok: boolean; oomPolicy: boolean; systemdRun: string; envProgram: string; systemctl: string }

export class MemoryFence {
  readonly #deps: FenceDeps;
  #probe: Probe | null = null;
  #applied: number | null = null;
  #cgroup: string | null = null;
  #checkedAt = -Infinity;
  #checkNow = false;

  constructor(deps: Partial<FenceDeps> = {}) { this.#deps = { ...realDeps, ...deps }; }

  wanted(): boolean { return fenceWanted(this.#deps.env, this.#deps.platform); }

  /** Whether every bot engine now starts inside the slice. The first call asks the user manager once. */
  active(): boolean {
    if (!this.wanted()) return false;
    this.#probe ??= this.#probeNow();
    return this.#probe.ok;
  }

  /** "slice" with the fence, "watchdog" where it is wanted and missing, else "none". */
  protection(): "slice" | "watchdog" | "none" {
    if (!this.wanted()) return "none";
    return this.active() ? "slice" : "watchdog";
  }

  /** The next `argv` checks at once that the user manager still answers. */
  recheck(): void { this.#checkNow = true; }

  #fail(reason: string): Probe {
    this.#deps.log(`the kernel memory limit for bots is not available here (${reason}); a watchdog keeps bot work under the limit instead`);
    return { ok: false, oomPolicy: false, systemdRun: "", envProgram: "", systemctl: "" };
  }

  #probeNow(): Probe {
    this.#checkedAt = this.#deps.now();
    return this.#look();
  }

  #look(): Probe {
    const exists = (path: string) => this.#deps.exists(path);
    const systemdRun = findProgram("systemd-run", exists), systemctl = findProgram("systemctl", exists), envProgram = findProgram("env", exists);
    // The test scope runs `true` by its full path: systemd-run looks a bare name up on this server's PATH, which may be sealed.
    const trueProgram = findProgram("true", exists);
    if (!systemdRun || !systemctl || !envProgram || !trueProgram) return this.#fail("systemd is not installed");
    const budget = this.#deps.budget();
    if (budget === null) return this.#fail("no limit is set");
    const probe: Probe = { ok: true, oomPolicy: true, systemdRun, envProgram, systemctl };
    if (!this.#apply(probe, budget)) return this.#fail("the user manager refused the limit");
    const scope = (oomPolicy: boolean) => this.#deps.run(systemdRun, ["--user", "--scope", "--quiet", "--collect", `--slice=${this.#deps.slice()}`, ...(oomPolicy ? ["-p", "OOMPolicy=continue"] : []), "--", trueProgram]).status === 0;
    if (!scope(true)) {
      if (!scope(false)) return this.#fail("the user manager could not start a scope");
      probe.oomPolicy = false;
    }
    this.#cgroup = this.#readCgroup(probe);
    if (!this.#limitHolds(budget)) { this.#cgroup = null; return this.#fail("the memory controller is not available for bots"); }
    return probe;
  }

  /** Whether the kernel holds the slice to the budget: a host without the memory controller accepts the property and
   * limits nothing. */
  #limitHolds(budget: number): boolean {
    if (this.#cgroup === null) return false;
    const text = this.#deps.read(`/sys/fs/cgroup${this.#cgroup}/memory.max`)?.trim();
    return text !== undefined && /^\d+$/.test(text) && Math.abs(Number(text) - Math.floor(budget)) <= LIMIT_SLACK_BYTES;
  }

  #readCgroup(probe: Probe): string | null {
    const done = this.#deps.run(probe.systemctl, ["--user", "show", "-p", "ControlGroup", "--value", this.#deps.slice()]);
    const path = done.stdout.trim();
    return done.status === 0 && path.startsWith("/") && path !== "/" ? path : null;
  }

  #apply(probe: Probe, budget: number): boolean {
    const done = this.#deps.run(probe.systemctl, ["--user", "set-property", "--runtime", this.#deps.slice(), ...sliceProperties(budget, this.#deps.cpus())]);
    if (done.status === 0) this.#applied = budget;
    return done.status === 0;
  }

  /** Whether the user manager answers, asked at most every 10 seconds. When it does not, the probe runs once more; if that
   * fails too, the fence stays off for the rest of the run. */
  #managerAnswers(probe: Probe): boolean {
    const at = this.#deps.now();
    if (!this.#checkNow && at - this.#checkedAt < CHECK_EVERY_MS) return true;
    this.#checkNow = false;
    this.#checkedAt = at;
    const done = this.#deps.run(probe.systemctl, ["--user", "show", "-p", "Version", "--value"], CHECK_TIMEOUT_MS);
    if (done.status === 0 && done.stdout.trim() !== "") return true;
    this.#cgroup = null;
    this.#applied = null;
    this.#probe = this.#look();
    return this.#probe.ok;
  }

  /** The command and arguments that start `command` inside the slice, or null when the fence is not active. The limit is
   * set again first when the budget changed, so it holds for every engine that starts after a change. */
  argv(command: string, args: readonly string[], env: NodeJS.ProcessEnv): FencedSpawn | null {
    if (!this.active() || !this.#probe || !this.#managerAnswers(this.#probe) || !this.#probe.ok) return null;
    const budget = this.#deps.budget();
    if (budget === null) return null;
    if (budget !== this.#applied && !this.#apply(this.#probe, budget)) this.#deps.log("the new memory limit for bots could not be set; the old one stays until it can");
    return fenceArgv({ systemdRun: this.#probe.systemdRun, envProgram: this.#probe.envProgram, slice: this.#deps.slice(), oomPolicy: this.#probe.oomPolicy, command, args, env, processEnv: this.#deps.env });
  }

  budgetBytes(): number | null { return this.#applied ?? this.#deps.budget(); }

  #sliceDir(): string | null {
    if (!this.active() || !this.#probe) return null;
    this.#cgroup ??= this.#readCgroup(this.#probe);
    return this.#cgroup === null ? null : `/sys/fs/cgroup${this.#cgroup}`;
  }

  /** The slice's memory in use, in bytes, without file pages the kernel can drop at once. */
  sliceCurrent(): number | null {
    const dir = this.#sliceDir(), text = dir === null ? null : this.#deps.read(`${dir}/memory.current`);
    if (dir === null || text === null || !/^\d+/.test(text.trim())) return null;
    return Math.max(0, Number(text.trim()) - inactiveFileBytes(this.#deps.read(`${dir}/memory.stat`)));
  }

  /** Programs the kernel stopped for memory anywhere in the slice. */
  sliceKills(): number | null {
    const dir = this.#sliceDir();
    return dir === null ? null : killsOf(this.#deps.read(`${dir}/memory.events`));
  }

  /** Programs the kernel stopped in the scope that holds this process, when that scope is under the slice. */
  scopeKills(pid: number): number | null {
    const own = /^0::(\/.*)$/m.exec(this.#deps.read(`/proc/${pid}/cgroup`) ?? "")?.[1];
    if (own === undefined || this.#cgroup === null || !own.startsWith(`${this.#cgroup}/`)) return null;
    return killsOf(this.#deps.read(`/sys/fs/cgroup${own}/memory.events`));
  }
}

export const memoryFence = new MemoryFence();

export interface FenceView {
  active(): boolean;
  sliceKills(): number | null;
  scopeKills(pid: number): number | null;
  budgetBytes(): number | null;
}

export interface FenceWatchOptions {
  fence?: FenceView;
  /** Calls `fn` every `ms` until the returned function runs. */
  every?: (ms: number, fn: () => void) => () => void;
  log?: (line: string) => void;
}

const everyMs = (ms: number, fn: () => void): (() => void) => {
  const timer = setInterval(fn, ms);
  timer.unref?.();
  return () => clearInterval(timer);
};

interface TurnMark { scope: number; slice: number; toldScope: number; toldSlice: number; pid?: number }

/**
 * Every engine's adapter: while a turn runs under the fence, a program the kernel stopped for memory is told to the bot
 * in the same turn and, in one line, to the person. The instance is changed in place.
 */
export function withMemoryFence(instance: ProviderInstance, options: FenceWatchOptions = {}): ProviderInstance {
  const fence = options.fence ?? memoryFence, every = options.every ?? everyMs, log = options.log ?? ((line: string) => console.warn(`memory: ${line}`));
  const adapter = instance.adapter;
  const listeners = new Set<RuntimeEventListener>();
  const turns = new Map<string, TurnMark>();
  let stopTimer: (() => void) | null = null, lastSlice = 0;

  /** The driver may drop the thread's engine before the turn's end event, so the pid is kept from while it ran. */
  const learn = (threadId: string, mark: TurnMark) => {
    if (mark.pid !== undefined) return;
    const pid = adapter.enginePid?.(threadId);
    if (pid === undefined) return;
    mark.pid = pid;
    mark.scope = fence.scopeKills(pid) ?? 0;
  };
  const scopeOf = (threadId: string, mark: TurnMark) => { const pid = adapter.enginePid?.(threadId) ?? mark.pid; return pid === undefined ? null : fence.scopeKills(pid); };
  const notify = (threadId: string, told: boolean, turnId?: string) => {
    const gb = gbText(fence.budgetBytes() ?? 0);
    const key = told ? "chat.notice.memoryFenceStop" : "chat.notice.memoryFenceStopUntold";
    const event = { eventId: newEventId(), provider: instance.driverKind, threadId, createdAt: new Date().toISOString(), ...(turnId ? { turnId } : {}), type: "runtime.notice", ...noticeFailure(key, { gb }) } as RuntimeEvent;
    for (const listener of listeners) listener(event);
    return gb;
  };
  /** Whether this turn's programs were stopped for memory since it began or since it was last told. */
  const grew = (threadId: string, mark: TurnMark): boolean => {
    const scope = scopeOf(threadId, mark);
    if (scope !== null) {
      if (scope <= Math.max(mark.scope, mark.toldScope)) return false;
      // The slice counted the same stop: a later check that finds no engine may read only the slice.
      mark.toldScope = scope;
      mark.toldSlice = Math.max(mark.toldSlice, fence.sliceKills() ?? 0);
      return true;
    }
    const slice = fence.sliceKills();
    if (slice === null || turns.size !== 1 || slice <= Math.max(mark.slice, mark.toldSlice)) return false;
    mark.toldSlice = slice;
    return true;
  };
  const tell = (threadId: string, final: boolean, turnId?: string) => {
    const mark = turns.get(threadId);
    if (!mark || !grew(threadId, mark)) return;
    if (final) {
      const gb = notify(threadId, false, turnId);
      log(`a program of a turn that had just ended ran out of memory (limit ${gb} GB); the bot could not be told`);
      return;
    }
    const steered = adapter.steer ? adapter.steer(threadId, fenceOomBotText(gbText(fence.budgetBytes() ?? 0)), []).catch(() => "refused" as const) : Promise.resolve("refused" as const);
    void steered.then((outcome) => {
      const gb = notify(threadId, outcome === "steered", turnId);
      if (outcome !== "steered") log(`a program of a running turn ran out of memory (limit ${gb} GB); the bot could not be told`);
    });
  };
  const poll = () => {
    for (const [threadId, mark] of turns) learn(threadId, mark);
    const slice = fence.sliceKills();
    if (slice === null || slice <= lastSlice) return;
    lastSlice = slice;
    for (const threadId of turns.keys()) tell(threadId, false);
  };
  const begin = (threadId: string) => {
    if (!fence.active()) return;
    const slice = fence.sliceKills() ?? 0, mark: TurnMark = { scope: 0, slice, toldScope: 0, toldSlice: 0 };
    turns.set(threadId, mark);
    learn(threadId, mark);
    if (!stopTimer) { lastSlice = slice; stopTimer = every(OOM_POLL_MS, poll); }
  };
  const end = (threadId: string) => {
    turns.delete(threadId);
    if (!turns.size && stopTimer) { stopTimer(); stopTimer = null; }
  };

  // Registered first, so its notice reaches the listeners before the turn's own end.
  adapter.onEvent((item) => {
    const mark = turns.get(item.threadId);
    if (!mark) return;
    learn(item.threadId, mark);
    if (item.type !== "turn.completed") return;
    tell(item.threadId, true, item.turnId);
    end(item.threadId);
  });
  (instance as { adapter: ProviderAdapter }).adapter = {
    ...adapter,
    onEvent: (listener) => {
      listeners.add(listener);
      const off = adapter.onEvent(listener);
      return () => { listeners.delete(listener); off(); };
    },
    sendTurn: async (input) => {
      begin(input.threadId);
      try { return await adapter.sendTurn(input); } catch (error) { end(input.threadId); throw error; }
    },
  };
  return instance;
}
