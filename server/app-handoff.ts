// The launcher's side of an npm update. The launcher stays alive when the server asks for a restart after an update: it
// backs up the data, starts the new copy, waits until that copy answers with its own version, and otherwise puts the data
// back and keeps the old version. The code that rolls back is the code that already runs.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  backupData, backupFolder, changeAppState, readAppState, realDeps, restoreData, prune, runningCopy, validCopy,
  type AppUpdateDeps, type PendingApp,
} from "./app-update.ts";
import { RESTART_EXIT_CODE } from "./restart.ts";
import { isNewerVersion } from "./update-check.ts";

export const HANDOFF_ENV = "SEIRA_APP_HANDOFF";
export const HEALTH_WAIT_MS = 5 * 60_000;
export const STOP_GRACE_MS = 30_000;
const POLL_MS = 1_000;

export interface CopyProcess {
  exited: Promise<number>;
  kill(signal: NodeJS.Signals): void;
}

export interface HandoffDeps {
  dataDir: string;
  port: number;
  /** The version of the code that runs this launcher. */
  own: string;
  /** The CLI of this launcher, to tell if it is itself a copy under `<data dir>/app/`. */
  script?: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  app: AppUpdateDeps;
  start(cli: string, argv: string[], env: NodeJS.ProcessEnv): CopyProcess;
  /** The version the server on `port` answers with, or null. */
  health(port: number): Promise<string | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Calls `handler` on SIGINT and SIGTERM until the returned function runs. */
  onSignal(handler: (signal: NodeJS.Signals) => void): () => void;
  log(line: string): void;
  healthWaitMs?: number;
  stopGraceMs?: number;
}

export function realHandoffDeps(input: { dataDir: string; port: number; own: string; argv?: string[]; log?: (line: string) => void }): HandoffDeps {
  return {
    dataDir: input.dataDir,
    port: input.port,
    own: input.own,
    script: process.argv[1],
    argv: input.argv ?? process.argv.slice(2),
    env: process.env,
    app: realDeps(),
    start: (cli, argv, env) => {
      const child = spawn(process.execPath, [cli, ...argv], { env, stdio: "inherit" });
      const exited = new Promise<number>((resolve) => {
        child.on("error", () => resolve(1));
        child.on("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
      });
      return { exited, kill: (signal) => { child.kill(signal); } };
    },
    health: async (port) => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3_000) });
        const body = await response.json() as { version?: unknown };
        return typeof body.version === "string" ? body.version : null;
      } catch {
        return null;
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    onSignal: (handler) => {
      const signals = ["SIGINT", "SIGTERM"] as const;
      const listeners = signals.map((signal) => {
        const listener = () => handler(signal);
        process.on(signal, listener);
        return [signal, listener] as const;
      });
      return () => { for (const [signal, listener] of listeners) process.removeListener(signal, listener); };
    },
    log: input.log ?? ((line) => console.log(line)),
  };
}

function runFor(pending: PendingApp, outcome: "updated" | "rolled-back" | "rollback-failed" | "not-changed") {
  return {
    outcome, from: pending.from, to: pending.to, target: pending.to, at: pending.at, local: true as const,
    ...(pending.by === "automatic" ? { automatic: true as const } : {}),
  };
}

/** Waits for the signals of the launcher to reach the copy, and tells if one came. */
function watchSignals(deps: HandoffDeps, child: CopyProcess): { stopped(): boolean; dispose(): void } {
  let stopped = false;
  const dispose = deps.onSignal((signal) => {
    stopped = true;
    child.kill(signal);
  });
  return { stopped: () => stopped, dispose };
}

async function stopCopy(deps: HandoffDeps, child: CopyProcess): Promise<void> {
  child.kill("SIGTERM");
  const grace = deps.stopGraceMs ?? STOP_GRACE_MS;
  const gone = await Promise.race([child.exited.then(() => true), deps.sleep(grace).then(() => false)]);
  if (!gone) {
    child.kill("SIGKILL");
    await child.exited;
  }
}

/**
 * The server stopped with a pending update. Null when there was none, or when it was dropped and the own version goes on.
 * A number is the exit code of the launcher: the copy ran to its end, or the data could not be put back.
 */
export async function handoffAfterRestart(deps: HandoffDeps): Promise<number | null> {
  const { dataDir } = deps;
  const state = readAppState(dataDir);
  const pending = state.pending;
  if (!pending) return null;
  const drop = () => {
    changeAppState(dataDir, (s) => {
      const { pending: _gone, ...rest } = s;
      return { ...rest, last: runFor(pending, "not-changed") };
    });
    return runCurrent(deps, "restart");
  };
  const cli = validCopy(dataDir, { version: pending.to, dir: pending.dir });
  if (!cli || !isNewerVersion(pending.to, deps.own)) return drop();
  const earlier = pending.backup && dirname(resolve(pending.backup)) === resolve(backupFolder(dataDir)) && existsSync(pending.backup) ? pending.backup : undefined;
  const backup = earlier ? { ok: true as const, file: earlier } : await backupData(dataDir, pending.from, deps.app);
  if (!backup.ok) {
    deps.log("The update was not started: the data could not be copied first. The server goes on with the version it had.");
    return drop();
  }
  if (!earlier) changeAppState(dataDir, (s) => ({ ...s, pending: { ...pending, backup: backup.file } }));
  deps.log(`Starting version ${pending.to}. If it does not answer within ${Math.round((deps.healthWaitMs ?? HEALTH_WAIT_MS) / 60_000)} minutes, the server goes back to version ${deps.own}.`);
  const child = deps.start(cli, deps.argv, { ...deps.env, [HANDOFF_ENV]: "restart" });
  const signals = watchSignals(deps, child);
  let exited: number | undefined;
  void child.exited.then((code) => { exited = code; });
  const deadline = deps.now() + (deps.healthWaitMs ?? HEALTH_WAIT_MS);
  let healthy = false;
  let ran: { code: number; stopped: boolean } | undefined;
  try {
    while (exited === undefined && !signals.stopped() && deps.now() < deadline) {
      if (await deps.health(deps.port) === pending.to) {
        healthy = true;
        break;
      }
      await Promise.race([deps.sleep(POLL_MS), child.exited]);
    }
    if (healthy) {
      changeAppState(dataDir, (s) => {
        const { pending: _gone, ...rest } = s;
        return { ...rest, current: { version: pending.to, dir: pending.dir }, failed: s.failed.filter((version) => version !== pending.to), last: runFor(pending, "updated") };
      });
      prune(dataDir, runningCopy(dataDir, deps.script));
      deps.log(`Version ${pending.to} answers. The update is done.`);
      const code = await child.exited;
      ran = { code, stopped: signals.stopped() };
    } else if (signals.stopped()) {
      return await child.exited;
    } else if (exited === undefined) {
      await stopCopy(deps, child);
    }
  } finally {
    signals.dispose();
  }
  if (ran) return afterCopy(deps, ran);
  deps.log(`Version ${pending.to} did not start well. Putting back the data from before the update.`);
  const restored = await restoreData(dataDir, backup.file, deps.app);
  changeAppState(dataDir, (s) => {
    const { pending: _gone, ...rest } = s;
    return { ...rest, failed: s.failed.includes(pending.to) ? s.failed : [...s.failed, pending.to], last: runFor(pending, restored.ok ? "rolled-back" : "rollback-failed") };
  });
  if (!restored.ok) {
    deps.log(`The data could not be put back by itself. The copy from before the update is ${backup.file}.`);
    return 1;
  }
  deps.log(`The data is as it was. What the new version wrote is kept in ${restored.aside}.`);
  return runCurrent(deps, "restart");
}

/**
 * A copy ran to its end. A restart it asked for, with an update pending, is this launcher's to run: the copy's own
 * launcher stops there, so launchers do not pile up. Any other end is the copy's exit code.
 */
async function afterCopy(deps: HandoffDeps, ran: { code: number; stopped: boolean }): Promise<number | null> {
  if (ran.stopped || ran.code !== RESTART_EXIT_CODE || !readAppState(deps.dataDir).pending) return ran.code;
  return handoffAfterRestart(deps);
}

/** Runs the newest copy that is newer than this version, and follows it. Null: no such copy, so this version runs. */
async function runCurrent(deps: HandoffDeps, mode: "start" | "restart"): Promise<number | null> {
  const current = readAppState(deps.dataDir).current;
  if (!current || !isNewerVersion(current.version, deps.own)) return null;
  const cli = validCopy(deps.dataDir, current);
  if (!cli) return null;
  deps.log(`Starting version ${current.version}, the newest copy on this server.`);
  const child = deps.start(cli, deps.argv, { ...deps.env, [HANDOFF_ENV]: mode });
  const signals = watchSignals(deps, child);
  let ran: { code: number; stopped: boolean };
  try {
    ran = { code: await child.exited, stopped: signals.stopped() };
  } finally {
    signals.dispose();
  }
  return afterCopy(deps, ran);
}

/**
 * A fresh start of the first launcher. An update the server did not finish is finished first. Then a newer healthy copy
 * in `<data dir>/app/` runs in place of this version. Null: this version runs. The data is never put back for the copy
 * itself: it may have changed it.
 */
export async function handoffAtStart(deps: HandoffDeps): Promise<number | null> {
  if (deps.env[HANDOFF_ENV]) return null;
  if (readAppState(deps.dataDir).pending) return handoffAfterRestart(deps);
  return runCurrent(deps, "start");
}
