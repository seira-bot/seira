import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

/** The variable that tells `seira-job-fence.exe --` which job to start the program in. The helper removes it from the
 * program's environment. */
export const JOB_FENCE_ENV = "SEIRA_FENCE_JOB";
const EXE = "seira-job-fence.exe";
const MIB = 1024 * 1024;

export function jobFencePath(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): string | null {
  const candidates = [
    env.SEIRA_RESOURCES_PATH ? join(env.SEIRA_RESOURCES_PATH, "job-fence", EXE) : null,
    join(dirname(fileURLToPath(import.meta.url)), "..", "dist-native", "job-fence", "win32-x64", EXE),
  ];
  return candidates.find((candidate): candidate is string => candidate !== null && exists(candidate)) ?? null;
}

/** Windows keeps a `Local\` name in the signed-in session. The helper adds its own pid, so two servers of one person
 * never share a job. */
export function jobBaseName(home: string): string {
  return `Local\\Seira-bots-${createHash("sha256").update(home).digest("hex").slice(0, 10)}`;
}

/** The helper passes its command line after `--` to CreateProcess unchanged, so the program gets the quoting Node gives it.
 * CreateProcess runs a .bat or .cmd file through cmd.exe, which parses the arguments again (CVE-2024-27980): like Node's
 * own spawn, this refuses one with EINVAL. Windows drops trailing dots and spaces from a file name. */
export function jobFenceArgv(helper: string, command: string, args: readonly string[]): { command: string; args: string[] } {
  if (/\.(?:bat|cmd)[.\s]*$/i.test(command)) throw Object.assign(new Error(`will not start ${command} in the memory job`), { code: "EINVAL" });
  return { command: helper, args: ["--", command, ...args] };
}

export const jobFenceEnv = (env: NodeJS.ProcessEnv, job: string): NodeJS.ProcessEnv => ({ ...env, [JOB_FENCE_ENV]: job });

export type JobFenceEvent =
  | { event: "ready"; job: string; limitBytes: number; pid: number }
  | { event: "limit"; limitBytes: number }
  | { event: "stats"; processes: number; jobBytes: number; peakBytes: number; limitBytes: number }
  | { event: "memory-stop"; pid: number; name: string; bytes: number; jobBytes: number; limitBytes: number; root: number; helper: number; by: number }
  | { event: "memory-denied"; by: number; jobBytes: number; limitBytes: number }
  | { event: "error"; step: string; code: number; pid?: number };

const NUMBERS: Record<JobFenceEvent["event"], readonly string[]> = {
  ready: ["limitBytes", "pid"],
  limit: ["limitBytes"],
  stats: ["processes", "jobBytes", "peakBytes", "limitBytes"],
  "memory-stop": ["pid", "bytes", "jobBytes", "limitBytes", "root", "helper", "by"],
  "memory-denied": ["by", "jobBytes", "limitBytes"],
  error: ["code"],
};
const TEXTS: Partial<Record<JobFenceEvent["event"], readonly string[]>> = { ready: ["job"], "memory-stop": ["name"], error: ["step"] };

export function parseJobFenceLine(line: string): JobFenceEvent | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const kind = record.event;
  if (typeof kind !== "string" || !Object.hasOwn(NUMBERS, kind)) return null;
  const event = kind as JobFenceEvent["event"];
  if (!NUMBERS[event].every((key) => Number.isSafeInteger(record[key]) && (record[key] as number) >= 0)) return null;
  if (!(TEXTS[event] ?? []).every((key) => typeof record[key] === "string")) return null;
  return record as unknown as JobFenceEvent;
}

export interface JobHold {
  /** The job name to put in JOB_FENCE_ENV. */
  job: string;
  pid: number;
  limitBytes(): number;
  setLimit(bytes: number): void;
  /** Asks for a "stats" event. */
  stats(): void;
  alive(): boolean;
  close(): void;
}

type HoldProcess = ChildProcessByStdio<Writable, Readable, null>;

export interface JobHoldOptions {
  helper: string;
  base: string;
  limitBytes: number;
  onEvent?: (event: JobFenceEvent) => void;
  /** Once, when the helper ends: after it was ready, or when it never got ready. */
  onExit?: () => void;
  readyMs?: number;
  start?: (command: string, args: string[]) => HoldProcess;
}

const startHelper = (command: string, args: string[]): HoldProcess =>
  spawn(command, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });

const limitMib = (bytes: number): number => Math.max(1, Math.floor(bytes / MIB));

/** Starts `seira-job-fence.exe hold`, which owns the bots' job for as long as its stdin stays open. Null when the
 * helper cannot start or does not get ready in time: then bot work runs without a job. */
export function startJobHold(options: JobHoldOptions): Promise<JobHold | null> {
  let child: HoldProcess;
  try {
    child = (options.start ?? startHelper)(options.helper, ["hold", options.base, String(limitMib(options.limitBytes))]);
  } catch {
    options.onExit?.();
    return Promise.resolve(null);
  }
  let exited = false;
  let mib = limitMib(options.limitBytes);
  return new Promise((resolve) => {
    let hold: JobHold | null = null;
    const settle = (value: JobHold | null) => { clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { if (!hold) { child.kill(); settle(null); } }, options.readyMs ?? 10_000);
    const ended = () => {
      if (exited) return;
      exited = true;
      if (!hold) settle(null);
      options.onExit?.();
    };
    child.once("error", ended);
    child.once("exit", ended);
    child.stdin.on("error", () => {});
    createInterface({ input: child.stdout }).on("line", (line) => {
      const event = parseJobFenceLine(line);
      if (!event) return;
      if (event.event === "ready" && !hold) {
        hold = {
          job: event.job,
          pid: event.pid,
          limitBytes: () => mib * MIB,
          setLimit(bytes) {
            const next = limitMib(bytes);
            if (next === mib || exited) return;
            mib = next;
            child.stdin.write(`limit ${next}\n`);
          },
          stats: () => { if (!exited) child.stdin.write("stats\n"); },
          alive: () => !exited,
          close: () => { if (!exited) child.stdin.end(); },
        };
        settle(hold);
      }
      try { options.onEvent?.(event); } catch { /* a failing listener never stops the hold */ }
    });
    // The server never waits on the helper to exit; closing the server closes the pipe, and the helper exits.
    child.unref();
    for (const stream of [child.stdin, child.stdout] as const) (stream as unknown as { unref?: () => void }).unref?.();
  });
}
