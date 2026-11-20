#!/usr/bin/env -S node --experimental-strip-types
// Launches the packaged Linux app and reports the median of each startup phase, for cold and warm opens.
//   node --experimental-strip-types scripts/bench-startup.ts [--executable PATH] [--cold 5] [--warm 5] [--out FILE]
//     [--timeout-ms 120000] [--prime-hold-ms 12000] [--host-network] [--keep]
// Every launch gets a temporary HOME and XDG folders, the managed broker off and a dead loopback updates origin. The
// app runs in a private network namespace with only loopback, because port 8799 belongs to an installed app.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, openSync, closeSync } from "node:fs";
import { connect } from "node:net";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEPT_ENV = ["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR", "DISPLAY", "XAUTHORITY"] as const;
const APP_PORTS = [8799, 18799, 28799];

export type Marks = Record<string, number>;
export type Run = { ok: boolean; marks?: Marks; error?: string; logTail?: string };
export type Summary = Record<string, { median: number; min: number; max: number; runs: number }>;

export function launchEnv(base: NodeJS.ProcessEnv, sandboxDir: string, timelinePath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of KEPT_ENV) if (base[key] !== undefined) env[key] = base[key];
  env.HOME = join(sandboxDir, "home");
  env.XDG_CONFIG_HOME = join(sandboxDir, "config");
  env.XDG_CACHE_HOME = join(sandboxDir, "cache");
  env.XDG_DATA_HOME = join(sandboxDir, "data");
  env.XDG_RUNTIME_DIR = join(sandboxDir, "run");
  env.SEIRA_COMPOSIO_BROKER = "off";
  env.SEIRA_UPDATES_ORIGIN = "http://127.0.0.1:9";
  env.SEIRA_STARTUP_TIMELINE = timelinePath;
  return env;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function summarize(runs: Run[]): Summary {
  const byName = new Map<string, number[]>();
  for (const run of runs) {
    if (!run.ok || !run.marks) continue;
    for (const [name, ms] of Object.entries(run.marks)) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name)!.push(ms);
    }
  }
  const out: Summary = {};
  for (const [name, values] of byName) out[name] = { median: median(values), min: Math.min(...values), max: Math.max(...values), runs: values.length };
  return out;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function portAccepts(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => { socket.destroy(); done(true); });
    socket.once("error", () => done(false));
  });
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) done();
    else child.once("exit", () => done());
  });
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try { process.kill(-child.pid!, signal); } catch {}
}

function logTail(file: string): string {
  try { return readFileSync(file, "utf8").split("\n").slice(-30).join("\n"); } catch { return ""; }
}

function readTimeline(file: string): Marks | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed.marks === "object" ? parsed.marks : null;
  } catch { return null; }
}

type Options = { executable: string; timeoutMs: number; hostNetwork: boolean };

async function launchOnce(options: Options, sandbox: string, label: string, holdMs = 0): Promise<Run> {
  const timeline = join(sandbox, `timeline-${label}.json`);
  const logFile = join(sandbox, `app-${label}.log`);
  const env = launchEnv(process.env, sandbox, timeline);
  const appCommand = [options.executable, "--password-store=basic"];
  const wrapped = env.DISPLAY ? appCommand : ["xvfb-run", "-a", "-s", "-screen 0 1440x900x24", ...appCommand];
  const command = options.hostNetwork
    ? wrapped
    : ["unshare", "-Urn", "sh", "-c", 'u=$1; g=$2; shift 2; ip link set lo up && exec unshare -U --map-user="$u" --map-group="$g" "$@"', "sh", String(process.getuid!()), String(process.getgid!()), ...wrapped];
  const logFd = openSync(logFile, "a");
  const child = spawn(command[0], command.slice(1), { env, detached: true, stdio: ["ignore", logFd, logFd] });
  closeSync(logFd);
  const spawnFailure = new Promise<string>((done) => child.once("error", (error) => done(String(error))));
  let marks: Marks | null = null;
  let error: string | undefined;
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    marks = readTimeline(timeline);
    if (marks) break;
    if (child.exitCode !== null || child.signalCode !== null) { error = "app exited before the window was shown"; break; }
    const failure = await Promise.race([spawnFailure, sleep(100).then(() => null)]);
    if (failure) { error = failure; break; }
  }
  if (!marks && !error) error = `no timeline after ${options.timeoutMs} ms`;
  if (marks && holdMs > 0) await sleep(holdMs);
  killGroup(child, "SIGTERM");
  const grace = await Promise.race([exited(child).then(() => true), sleep(20_000).then(() => false)]);
  if (!grace) { killGroup(child, "SIGKILL"); await exited(child); }
  return marks ? { ok: true, marks } : { ok: false, error, logTail: logTail(logFile) };
}

function newSandbox(): string {
  const sandbox = mkdtempSync(join(tmpdir(), "seira-bench-startup-"));
  for (const name of ["home", "config", "cache", "data"]) mkdirSync(join(sandbox, name), { recursive: true });
  mkdirSync(join(sandbox, "run"), { recursive: true, mode: 0o700 });
  return sandbox;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      executable: { type: "string", default: join(ROOT, "release/linux-unpacked/seira") },
      cold: { type: "string", default: "5" },
      warm: { type: "string", default: "5" },
      out: { type: "string" },
      "timeout-ms": { type: "string", default: "120000" },
      "prime-hold-ms": { type: "string", default: "12000" },
      "host-network": { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
    },
  });
  if (process.platform !== "linux") {
    console.error("bench-startup runs on Linux only.");
    process.exit(2);
  }
  const executable = resolve(values.executable!);
  if (!existsSync(executable)) {
    console.error(`Executable not found: ${executable}`);
    process.exit(2);
  }
  const options: Options = { executable, timeoutMs: Number(values["timeout-ms"]), hostNetwork: values["host-network"]! };
  if (options.hostNetwork) {
    for (const port of APP_PORTS) {
      if (await portAccepts(port)) {
        console.error(`Port ${port} accepts connections. Another app is running. Run without --host-network.`);
        process.exit(2);
      }
    }
  }
  const sandboxes: string[] = [];
  const cold: Run[] = [];
  const warm: Run[] = [];
  try {
    for (let i = 0; i < Number(values.cold); i++) {
      const sandbox = newSandbox();
      sandboxes.push(sandbox);
      cold.push(await launchOnce(options, sandbox, "cold"));
    }
    if (Number(values.warm) > 0) {
      const sandbox = newSandbox();
      sandboxes.push(sandbox);
      await launchOnce(options, sandbox, "prime", Number(values["prime-hold-ms"]));
      for (let i = 0; i < Number(values.warm); i++) warm.push(await launchOnce(options, sandbox, `warm${i}`));
    }
  } finally {
    if (!values.keep) for (const sandbox of sandboxes) rmSync(sandbox, { recursive: true, force: true });
  }
  const report = {
    executable,
    host: { platform: process.platform, arch: process.arch, cpus: cpus().length, loadavg: loadavg() },
    network: options.hostNetwork ? "host" : "private",
    cold: { runs: cold, summary: summarize(cold) },
    warm: { runs: warm, summary: summarize(warm) },
  };
  const json = JSON.stringify(report, null, 2);
  console.log(json);
  if (values.out) writeFileSync(values.out, `${json}\n`);
  const names = [...new Set([...Object.keys(report.cold.summary), ...Object.keys(report.warm.summary)])];
  const pad = (text: string, width: number) => text.padEnd(width);
  console.error(`${pad("phase", 18)}${pad("cold median", 14)}warm median`);
  for (const name of names) {
    console.error(`${pad(name, 18)}${pad(String(report.cold.summary[name]?.median ?? "-"), 14)}${report.warm.summary[name]?.median ?? "-"}`);
  }
  const failed = [...cold, ...warm].filter((run) => !run.ok);
  for (const run of failed) console.error(`failed run: ${run.error}\n${run.logTail ?? ""}`);
  process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
