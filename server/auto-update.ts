// The night update of a self-hosted server. Every few minutes the server asks whether this is the time: inside the window,
// switched on, a newer release there, and no bot answering. It then makes the same request as the Update server button.
import type { ServerUpdateStatus } from "../shared/server-update.ts";
import type { AdminActor } from "./admin-activity.ts";

export const CHECK_EVERY_MS = 10 * 60_000;
/** Local time, minutes after midnight: from 03:00 up to, but not including, 05:00. */
export const WINDOW_START_MINUTE = 3 * 60;
export const WINDOW_END_MINUTE = 5 * 60;

export interface AutoUpdateDeps {
  status(): Promise<ServerUpdateStatus>;
  request(actor: AdminActor): Promise<{ status: number; body: Record<string, unknown> }>;
  now(): Date;
  /** Versions that did not work on this server. */
  failed(): string[];
}

export function inWindow(at: Date): boolean {
  const minute = at.getHours() * 60 + at.getMinutes();
  return minute >= WINDOW_START_MINUTE && minute < WINDOW_END_MINUTE;
}

const night = (at: Date) => `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`;

/** One try for each version in each night, kept in memory: a server that restarts has either updated or rolled back. */
export function createAutoUpdate(deps: AutoUpdateDeps): { tick(): Promise<"updating" | "waiting">; } {
  const tried = new Map<string, string>();
  let working = false;
  return {
    async tick() {
      const at = deps.now();
      if (working || !inWindow(at)) return "waiting";
      working = true;
      try {
        const status = await deps.status().catch(() => null);
        if (!status || !status.auto?.on || status.mode !== "button" || !status.available || !status.latest) return "waiting";
        if (status.activeTurns > 0) return "waiting";
        if (status.run?.outcome === "requested" || status.run?.outcome === "running") return "waiting";
        if (deps.failed().includes(status.latest)) return "waiting";
        if (tried.get(status.latest) === night(at)) return "waiting";
        tried.set(status.latest, night(at));
        await deps.request({ kind: "automatic" });
        return "updating";
      } finally {
        working = false;
      }
    },
  };
}

export function startAutoUpdate(deps: AutoUpdateDeps, everyMs = CHECK_EVERY_MS): { stop(): void } {
  const auto = createAutoUpdate(deps);
  const timer = setInterval(() => void auto.tick().catch(() => {}), everyMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
