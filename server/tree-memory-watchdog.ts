import { attributeRows, SHARED, type BotTally, type FootprintOwner } from "./perf/bot-footprint.ts";
import type { ProcessRow } from "./perf/process-buckets.ts";

export interface TreeMemoryStop {
  /** Null when the process counts as shared. */
  botId: string | null;
  pid: number;
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
}

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
  let overSince: number | null = null;
  let pending: { pid: number; name: string; at: number } | null = null;
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const target = (tallies: ReadonlyArray<readonly [string | null, BotTally]>, byPid: ReadonlyMap<number, ProcessRow>) => {
    let best: { botId: string | null; row: ProcessRow; tallyBytes: number } | null = null;
    for (const [botId, tally] of tallies) {
      const roots = new Set<number>();
      for (const unit of tally.units.values()) if (unit.kind === "engine") roots.add(unit.root);
      let pick: ProcessRow | null = null;
      for (const pid of tally.pids) {
        const row = byPid.get(pid);
        if (!row || pid <= 1 || pid === serverPid || roots.has(pid)) continue;
        if (pick === null || row.rssBytes > pick.rssBytes) pick = row;
      }
      if (pick && (best === null || tally.rssBytes > best.tallyBytes)) best = { botId, row: pick, tallyBytes: tally.rssBytes };
    }
    return best;
  };

  const run = async (): Promise<void> => {
    const budget = options.budgetBytes();
    if (budget === null || !(budget > 0)) { overSince = null; pending = null; return; }
    const rows = await options.list();
    if (rows === null) return;
    const at = now();
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    if (pending) {
      const row = byPid.get(pending.pid);
      if (!row || row.name !== pending.name) pending = null;
      else if (at - pending.at >= graceMs) { signal(pending.pid, "SIGKILL"); pending = null; }
    }
    const attribution = attributeRows(rows, options.owners());
    const tallies: Array<readonly [string | null, BotTally]> = [...attribution.bots].map(([id, tally]) => [id === SHARED ? null : id, tally] as const);
    tallies.push([null, attribution.shared]);
    const total = tallies.reduce((sum, [, tally]) => sum + tally.rssBytes, 0);
    if (total <= budget) { overSince = null; return; }
    overSince ??= at;
    if (pending) return;
    if (at - overSince < overForMs) {
      const free = options.available?.() ?? null;
      if (free === null || free >= urgentBelowBytes) return;
    }
    const found = target(tallies, byPid);
    if (!found) return;
    if (!signal(found.row.pid, "SIGTERM")) return;
    pending = { pid: found.row.pid, name: found.row.name, at };
    overSince = at;
    try {
      options.onStop?.({ botId: found.botId, pid: found.row.pid, name: found.row.name, bytes: found.row.rssBytes, totalBytes: total, budgetBytes: budget });
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
  };
}
