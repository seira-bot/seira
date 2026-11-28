import type { ServerUpdateStatus } from "../shared/server-update.ts";
import type { ServerUpdater } from "./server-update.ts";

export const AUTO_UPDATE_ENV = "SEIRA_AUTO_UPDATE";
export const AUTO_UPDATE_INTERVAL_MS = 15 * 60_000;
export const AUTO_UPDATE_IDLE_MS = 10 * 60_000;
export const AUTO_UPDATE_GAP_MS = 6 * 60 * 60_000;

export interface AutoUpdateOptions {
  updater: ServerUpdater;
  activeTurns(): number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Runs `tick` every `ms` until the returned function is called. */
  schedule?: (tick: () => void, ms: number) => () => void;
}

export function autoUpdateOff(env: NodeJS.ProcessEnv): boolean {
  return ["off", "0", "false", "no"].includes(env[AUTO_UPDATE_ENV]?.trim().toLowerCase() ?? "");
}

function wanted(status: ServerUpdateStatus): boolean {
  if (status.mode !== "button" || !status.available || status.retryAt) return false;
  const run = status.run;
  if (run?.outcome === "requested" || run?.outcome === "running") return false;
  const wentBack = run?.outcome === "rolled-back" || run?.outcome === "rollback-failed";
  return !(wentBack && (!run.target || run.target === status.latest));
}

function everyInterval(tick: () => void, ms: number): () => void {
  const timer = setInterval(tick, ms);
  timer.unref();
  return () => clearInterval(timer);
}

/** Asks the host's runner for the stable update when the server has had no turn for ten minutes, at most once in six hours. */
export function startAutoUpdate(options: AutoUpdateOptions): { stop(): void } {
  if (autoUpdateOff(options.env ?? process.env)) return { stop() {} };
  const now = options.now ?? Date.now;
  let idleSince: number | null = null;
  let askedAt: number | null = null;
  let ticking = false;

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      if (options.activeTurns() > 0) idleSince = null;
      else idleSince ??= now();
      const status = await options.updater.status();
      if (status.activeTurns > 0) idleSince = null;
      if (!wanted(status) || idleSince === null || now() - idleSince < AUTO_UPDATE_IDLE_MS) return;
      if (askedAt !== null && now() - askedAt < AUTO_UPDATE_GAP_MS) return;
      askedAt = now();
      const answer = await options.updater.request({ kind: "auto-update" });
      if (answer.status !== 202) console.warn(`automatic update: the host did not take the request (${answer.status})`);
    } catch (error) {
      console.warn(`automatic update: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      ticking = false;
    }
  }

  const cancel = (options.schedule ?? everyInterval)(() => void tick(), AUTO_UPDATE_INTERVAL_MS);
  return { stop: cancel };
}
