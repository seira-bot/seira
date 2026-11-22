import { attributeRows, SHARED, type BotTally, type FootprintOwner } from "./perf/bot-footprint.ts";
import type { ProcessRow } from "./perf/process-buckets.ts";

export interface TreeMemoryStop {
  /** Null when the process counts as shared. */
  botId: string | null;
  pid: number;
  /** The owner process (an engine or a browser) whose tree held it; null when none is known. */
  root: number | null;
  name: string;
  bytes: number;
  totalBytes: number;
  budgetBytes: number;
}

type Rows = readonly ProcessRow[] | null;

export interface TreeMemoryWatchdogOptions {
  list: () => Promise<Rows> | Rows;
  owners: () => readonly FootprintOwner[];
  /** Null or zero: the watchdog does nothing. */
  budgetBytes: () => number | null;
  signal?: (pid: number, signal: "SIGTERM" | "SIGKILL") => boolean;
  onStop?: (event: TreeMemoryStop) => void;
  now?: () => number;
  intervalMs?: number;
  overForMs?: number;
  graceMs?: number;
  serverPid?: number;
  /** The machine's available memory in bytes, or null when unknown. Below `urgentBelowBytes` a stop does not wait `overForMs`. */
  available?: () => number | null;
  urgentBelowBytes?: number;
  /** While bot work uses less than CALM_SHARE of the budget and memory is not short, the list is read at most this often.
   * 0: at every check. */
  calmMs?: number;
  /** Programs that only start another program: the processes these start are engines too. Lower-case names. */
  launchers?: ReadonlySet<string>;
}

/** A process the server starts to start an engine: the job helper on Windows, or a shell or PowerShell shim. */
export const ENGINE_LAUNCHERS: ReadonlySet<string> = new Set(["seira-job-fence.exe", "powershell.exe", "pwsh.exe", "cmd.exe", "sh", "bash", "zsh", "dash"]);
const CALM_SHARE = 0.75;

const kill = (pid: number, signal: "SIGTERM" | "SIGKILL"): boolean => {
  try { process.kill(pid, signal); return true; } catch { return false; }
};

export function createTreeMemoryWatchdog(options: TreeMemoryWatchdogOptions) {
  const signal = options.signal ?? kill;
  const now = options.now ?? (() => Date.now());
  const intervalMs = options.intervalMs ?? 2_000;
  const overForMs = options.overForMs ?? 10_000;
  const graceMs = options.graceMs ?? 3_000;
  const serverPid = options.serverPid ?? process.pid;
  const urgentBelowBytes = options.urgentBelowBytes ?? 1024 ** 3;
  const calmMs = options.calmMs ?? 0;
  const launchers = options.launchers ?? ENGINE_LAUNCHERS;
  let overSince: number | null = null;
  let pending: { pid: number; name: string; start: string; at: number } | null = null;
  let running = false;
  let used: number | null = null;
  let listedAt = -Infinity;
  let timer: ReturnType<typeof setInterval> | null = null;

  /** The engines: each engine root, and what a launcher root started, down to the first process that is not a launcher. */
  const enginesOf = (tally: BotTally, byPid: ReadonlyMap<number, ProcessRow>, kids: ReadonlyMap<number, readonly number[]>) => {
    const engines = new Set<number>();
    const add = (pid: number, depth: number) => {
      engines.add(pid);
      const row = byPid.get(pid);
      if (depth < 4 && row && launchers.has(row.name)) for (const kid of kids.get(pid) ?? []) add(kid, depth + 1);
    };
    for (const unit of tally.units.values()) if (unit.kind === "engine") add(unit.root, 0);
    return engines;
  };

  const target = (tallies: ReadonlyArray<readonly [string | null, BotTally]>, byPid: ReadonlyMap<number, ProcessRow>, kids: ReadonlyMap<number, readonly number[]>) => {
    let best: { botId: string | null; row: ProcessRow; tallyBytes: number; root: number | null } | null = null;
    for (const [botId, tally] of tallies) {
      const roots = enginesOf(tally, byPid, kids);
      let pick: ProcessRow | null = null;
      for (const pid of tally.pids) {
        const row = byPid.get(pid);
        if (!row || pid <= 1 || pid === serverPid || roots.has(pid)) continue;
        if (pick === null || row.rssBytes > pick.rssBytes) pick = row;
      }
      if (pick && (best === null || tally.rssBytes > best.tallyBytes)) {
        const owner = [...tally.units.values()].find((unit) => unit.pids.includes(pick!.pid));
        best = { botId, row: pick, tallyBytes: tally.rssBytes, root: owner?.root ?? null };
      }
    }
    return best;
  };

  const run = async (): Promise<void> => {
    const budget = options.budgetBytes();
    if (budget === null || !(budget > 0)) { overSince = null; pending = null; used = null; return; }
    if (calmMs > 0 && overSince === null && pending === null && used !== null && used < budget * CALM_SHARE && now() - listedAt < calmMs) {
      const free = options.available?.() ?? null;
      if (free === null || free >= 2 * urgentBelowBytes) return;
    }
    const rows = await options.list();
    // No list (no engine runs, or it could not be read): what was seen before may belong to other processes by the next list.
    if (rows === null) { overSince = null; pending = null; used = null; return; }
    const at = now();
    listedAt = at;
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const attribution = attributeRows(rows, options.owners());
    const tallies: Array<readonly [string | null, BotTally]> = [...attribution.bots].map(([id, tally]) => [id === SHARED ? null : id, tally] as const);
    tallies.push([null, attribution.shared]);
    if (pending) {
      // The system can give a stopped process's pid to a new process: kill only the same process, while it is bot work.
      const row = byPid.get(pending.pid);
      const held = tallies.some(([, tally]) => tally.pids.includes(pending!.pid));
      if (!row || row.name !== pending.name || row.start !== pending.start || !held) pending = null;
      else if (at - pending.at >= graceMs) { signal(pending.pid, "SIGKILL"); pending = null; }
    }
    const total = tallies.reduce((sum, [, tally]) => sum + tally.rssBytes, 0);
    used = total;
    if (total <= budget) { overSince = null; return; }
    overSince ??= at;
    if (pending) return;
    if (at - overSince < overForMs) {
      const free = options.available?.() ?? null;
      if (free === null || free >= urgentBelowBytes) return;
    }
    const kids = new Map<number, number[]>();
    for (const row of rows) if (row.ppid !== row.pid) (kids.get(row.ppid) ?? kids.set(row.ppid, []).get(row.ppid)!).push(row.pid);
    const found = target(tallies, byPid, kids);
    if (!found) return;
    if (!signal(found.row.pid, "SIGTERM")) return;
    pending = { pid: found.row.pid, name: found.row.name, start: found.row.start, at };
    overSince = at;
    try {
      options.onStop?.({ botId: found.botId, pid: found.row.pid, root: found.root, name: found.row.name, bytes: found.row.rssBytes, totalBytes: total, budgetBytes: budget });
    } catch { /* a failing listener never stops the watchdog */ }
  };

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try { await run(); } catch { /* the next tick tries again */ } finally { running = false; }
  };

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, intervalMs);
      timer.unref();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
    /** The bots' memory at the last look; null before one, or when the list was not read. */
    used: (): number | null => used,
  };
}
