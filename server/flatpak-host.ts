// Inside a Flatpak the agent CLIs (claude, codex, ...) live on the host, not in the sandbox. Every lookup and every
// launch below goes through `flatpak-spawn --host`, which needs the org.freedesktop.Flatpak bus name in finish-args.
// Arguments are always an argv array. The two shell scripts are constants that read their inputs as positional parameters.
// Environment values never enter an argv, which any user of the host can read in /proc: they travel on a descriptor (--env-fd).
import { execFile, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { openSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { serverMayRunFrom, serverPath } from "./bot-box/program-trust.ts";
import type { ResolvedSpawn } from "./env-path.ts";

export const FLATPAK_SPAWN = "/usr/bin/flatpak-spawn";

/** The descriptor `flatpak-spawn` reads the environment from: the first one after stdin, stdout and stderr. */
export const HOST_ENV_FD = 3;

const HOST_DEFAULT_PATH = "/usr/local/bin:/usr/bin";
const HOST_PROBE_TIMEOUT_MS = 5_000;
const CANDIDATE_TTL_MS = 3_000;

// Sandbox values that mean nothing, or something wrong, on the host.
const SANDBOX_ENV = /^(?:FLATPAK_.*|ZYPAK_.*|XDG_(?:CONFIG|DATA|CACHE|STATE)_HOME|XDG_(?:DATA|CONFIG)_DIRS|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|XAUTHORITY|TMPDIR|LD_LIBRARY_PATH|LD_PRELOAD|LD_AUDIT|GI_TYPELIB_PATH|GIO_EXTRA_MODULES|GST_.*|PKG_CONFIG_.*|CHROME_.*|container|PULSE_.*|PIPEWIRE_.*|AT_SPI_BUS_ADDRESS)$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Each hit prints two NUL-ended fields: the file, then where its links lead (empty when that cannot be resolved).
// A relative folder is skipped: the launch runs in another folder, where the same name means another file.
const FIND_ON_PATH = 'set -f; IFS=:; for d in $1; do case "$d" in /*) ;; *) continue ;; esac; p="$d/$2"; if [ -f "$p" ] && [ -x "$p" ]; then printf "%s\\0%s\\0" "$p" "$(readlink -f -- "$p")"; fi; done';
const FIND_FILE = 'if [ -f "$1" ] && [ -x "$1" ]; then printf "%s\\0%s\\0" "$1" "$(readlink -f -- "$1")"; fi';

export interface HostRunResult {
  status: number | null;
  stdout: string;
}

export type HostRunner = (argv: readonly string[]) => HostRunResult;

export interface HostProgram {
  path: string;
  real: string;
}

/** A command line for `flatpak-spawn`, and the environment block its descriptor HOST_ENV_FD must carry. */
export interface HostSpawn {
  command: string;
  args: string[];
  /** What `flatpak-spawn` itself runs with: only the way to the session bus. */
  env: NodeJS.ProcessEnv;
  /** NAME=value pairs ended by NUL: see hostEnvFile. */
  envBlock: string;
}

function defaultRunner(argv: readonly string[]): HostRunResult {
  const result = spawnSync(FLATPAK_SPAWN, [...argv], { encoding: "utf8", timeout: HOST_PROBE_TIMEOUT_MS, windowsHide: true });
  return { status: result.status, stdout: typeof result.stdout === "string" ? result.stdout : "" };
}

let runner: HostRunner = defaultRunner;
let basePath: string | null = null;
const candidates = new Map<string, { at: number; found: HostProgram[] }>();

export function inFlatpak(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.FLATPAK_ID === "string" && env.FLATPAK_ID !== "";
}

/** The app's own files: a Flatpak keeps them under /app, and they run in the sandbox. */
export function runsInSandbox(command: string): boolean {
  return command === process.execPath || command.startsWith("/app/");
}

/** The environment a host child gets: what the deb build would give it, minus the sandbox's own values. */
export function hostEnvEntries(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !ENV_NAME.test(name) || SANDBOX_ENV.test(name) || value.includes("\0")) continue;
    out.push(`${name}=${value}`);
  }
  return out;
}

/** The environment block in a nameless file of the runtime folder (memory-backed, owner only), as an open descriptor at offset 0.
 * `flatpak-spawn` opens /proc/self/fd/N itself, which a socket from a `"pipe"` stdio entry refuses. The caller closes the descriptor. */
export function hostEnvFile(block: string): number {
  const path = join(process.env.XDG_RUNTIME_DIR || tmpdir(), `.seira-env-${randomBytes(12).toString("hex")}`);
  const fd = openSync(path, "wx+", 0o600);
  try {
    unlinkSync(path);
    const data = Buffer.from(block);
    let done = 0;
    while (done < data.length) done += writeSync(fd, data, done, data.length - done, done);
    return fd;
  } catch (error) {
    try { unlinkSync(path); } catch {}
    throw error;
  }
}

/** The arguments of `flatpak-spawn` (the program itself is FLATPAK_SPAWN) that start `command` on the host. No value of
 * the environment is among them: see HostSpawn.envBlock. */
export function hostSpawnArgv(input: { command: string; args: readonly string[]; cwd?: string }): string[] {
  return [
    "--host",
    "--watch-bus",
    ...(input.cwd ? [`--directory=${input.cwd}`] : []),
    `--env-fd=${HOST_ENV_FD}`,
    "--",
    input.command,
    ...input.args,
  ];
}

/** The host's PATH as `flatpak-spawn --host` sees it: the user session's, before any shell start-up file. */
export function hostBasePath(): string {
  if (basePath === null) {
    const result = runner(["--host", "printenv", "PATH"]);
    const line = result.status === 0 ? result.stdout.split("\n")[0]?.trim() : "";
    basePath = line || HOST_DEFAULT_PATH;
  }
  return basePath;
}

/** Reads NUL-ended path and real fields. A field left over without its partner comes back with an empty `real`. */
export function parseHostPrograms(stdout: string): HostProgram[] {
  const fields = stdout.split("\0");
  fields.pop();
  const found: HostProgram[] = [];
  for (let i = 0; i < fields.length; i += 2) found.push({ path: fields[i]!, real: fields[i + 1] ?? "" });
  return found;
}

/** Every copy of `name` that exists on the host, searching `path` (host folders), with where its links lead.
 * Cached for a few seconds unless `fresh`: a decision to run a program must never rest on the cache. */
export function hostFindPrograms(name: string, path: string, fresh = false): HostProgram[] {
  const key = `${path}\0${name}`;
  const hit = candidates.get(key);
  if (!fresh && hit && Date.now() - hit.at < CANDIDATE_TTL_MS) return hit.found;
  const argv = /\//.test(name)
    ? ["--host", "/bin/sh", "-c", FIND_FILE, "sh", name]
    : ["--host", "/bin/sh", "-c", FIND_ON_PATH, "sh", path, name];
  const result = runner(argv);
  const found = result.status === 0 ? parseHostPrograms(result.stdout) : [];
  candidates.set(key, { at: Date.now(), found });
  return found;
}

export function hostFindCandidates(name: string, path: string): string[] {
  return hostFindPrograms(name, path).map((program) => program.path);
}

/** The host command line for `resolved`, or null when it should run here: off Flatpak, an app file, or no such program on
 * the host (the caller then gets the same ENOENT as on a deb). Throws EACCES, as outsideBoxOptions does, for a program in
 * a folder the bots can write. */
export function hostBridge(
  resolved: ResolvedSpawn,
  context: { cwd?: string | URL; env?: NodeJS.ProcessEnv },
  processEnv: NodeJS.ProcessEnv = process.env,
): HostSpawn | null {
  if (!inFlatpak(processEnv) || runsInSandbox(resolved.command)) return null;
  const cwd = typeof context.cwd === "string" && context.cwd ? context.cwd : undefined;
  const env = { ...(context.env ?? processEnv), ...resolved.env };
  const path = serverPath(env.PATH ?? hostBasePath());
  const name = /\//.test(resolved.command) && !isAbsolute(resolved.command) ? resolve(cwd ?? "/", resolved.command) : resolved.command;
  const program = hostFindPrograms(name, path, true)[0];
  if (!program) return null;
  if (!program.real || !serverMayRunFrom(program.path) || !serverMayRunFrom(program.real)) {
    throw Object.assign(new Error(`${resolved.command} is in a folder the bots can write, so the server does not run it outside the bot box.`), { code: "EACCES" });
  }
  const entries = hostEnvEntries({ ...env, PATH: path });
  // The link, not its target, as a shell and the deb's spawn start it: a program such as mise links every tool to itself
  // and picks the tool by the name it runs as. Started by its target, mise gets its own name and refuses the tool's flags.
  return {
    command: FLATPAK_SPAWN,
    args: hostSpawnArgv({ command: program.path, args: resolved.args, cwd }),
    env: busEnv(processEnv),
    envBlock: entries.map((entry) => `${entry}\0`).join(""),
  };
}

/** `flatpak-spawn` itself needs only the way to the session bus; everything else reaches the host child on the pipe. */
function busEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { PATH: "/app/bin:/usr/bin" };
  for (const name of ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "HOME"]) if (env[name]) out[name] = env[name];
  return out;
}

/** The PATH of the host's login shell, which holds what its start-up files add (nvm, ~/.local/bin). Null when it cannot be read. */
export function probeHostLoginPath(done: (path: string | null) => void): void {
  const fail = () => done(null);
  execFile(FLATPAK_SPAWN, ["--host", "printenv", "SHELL"], { timeout: HOST_PROBE_TIMEOUT_MS }, (error, stdout) => {
    const shell = String(stdout ?? "").split("\n")[0]?.trim();
    if (error || !shell) return fail();
    execFile(
      FLATPAK_SPAWN,
      ["--host", shell, "-l", "-i", "-c", 'printf "__SEIRA_PATH__%s" "$PATH"'],
      { timeout: HOST_PROBE_TIMEOUT_MS },
      (err, out) => {
        const match = err ? null : /__SEIRA_PATH__([^\n]*)/.exec(String(out ?? ""));
        done(match?.[1] || null);
      },
    );
  });
}

export function setHostRunnerForTests(next: HostRunner | null): void {
  runner = next ?? defaultRunner;
  resetHostCaches();
}

export function resetHostCaches(): void {
  basePath = null;
  candidates.clear();
}
