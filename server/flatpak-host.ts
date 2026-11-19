// Inside a Flatpak the agent CLIs (claude, codex, ...) live on the host, not in the sandbox. Every lookup and every
// launch below goes through `flatpak-spawn --host`, which needs the org.freedesktop.Flatpak bus name in finish-args.
// Arguments are always an argv array. The two shell scripts are constants that read their inputs as positional parameters.
import { execFile, spawnSync } from "node:child_process";
import type { ResolvedSpawn } from "./env-path.ts";

export const FLATPAK_SPAWN = "/usr/bin/flatpak-spawn";

const HOST_DEFAULT_PATH = "/usr/local/bin:/usr/bin";
const HOST_PROBE_TIMEOUT_MS = 5_000;
const CANDIDATE_TTL_MS = 3_000;

// Sandbox values that mean nothing, or something wrong, on the host.
const SANDBOX_ENV = /^(?:FLATPAK_.*|ZYPAK_.*|XDG_(?:CONFIG|DATA|CACHE|STATE)_HOME|XDG_(?:DATA|CONFIG)_DIRS|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|XAUTHORITY|TMPDIR|LD_LIBRARY_PATH|LD_PRELOAD|LD_AUDIT|GI_TYPELIB_PATH|GIO_EXTRA_MODULES|GST_.*|PKG_CONFIG_.*|CHROME_.*|container|PULSE_.*|PIPEWIRE_.*|AT_SPI_BUS_ADDRESS)$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const FIND_ON_PATH = 'set -f; IFS=:; for d in $1; do [ -n "$d" ] || continue; p="$d/$2"; if [ -f "$p" ] && [ -x "$p" ]; then printf "%s\\n" "$p"; fi; done';
const FIND_FILE = 'if [ -f "$1" ] && [ -x "$1" ]; then printf "%s\\n" "$1"; fi';

export interface HostRunResult {
  status: number | null;
  stdout: string;
}

export type HostRunner = (argv: readonly string[]) => HostRunResult;

function defaultRunner(argv: readonly string[]): HostRunResult {
  const result = spawnSync(FLATPAK_SPAWN, [...argv], { encoding: "utf8", timeout: HOST_PROBE_TIMEOUT_MS, windowsHide: true });
  return { status: result.status, stdout: typeof result.stdout === "string" ? result.stdout : "" };
}

let runner: HostRunner = defaultRunner;
let basePath: string | null = null;
const candidates = new Map<string, { at: number; found: string[] }>();

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

/** The arguments of `flatpak-spawn` (the program itself is FLATPAK_SPAWN) that start `command` on the host. */
export function hostSpawnArgv(input: { command: string; args: readonly string[]; cwd?: string; env: NodeJS.ProcessEnv }): string[] {
  return [
    "--host",
    "--watch-bus",
    ...(input.cwd ? [`--directory=${input.cwd}`] : []),
    ...hostEnvEntries(input.env).map((entry) => `--env=${entry}`),
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

/** Every copy of `name` that exists on the host, searching `path` (host folders). Cached for a few seconds. */
export function hostFindCandidates(name: string, path: string): string[] {
  const key = `${path}\0${name}`;
  const hit = candidates.get(key);
  if (hit && Date.now() - hit.at < CANDIDATE_TTL_MS) return hit.found;
  const argv = /\//.test(name)
    ? ["--host", "/bin/sh", "-c", FIND_FILE, "sh", name]
    : ["--host", "/bin/sh", "-c", FIND_ON_PATH, "sh", path, name];
  const result = runner(argv);
  const found = result.status === 0 ? result.stdout.split("\n").filter(Boolean) : [];
  candidates.set(key, { at: Date.now(), found });
  return found;
}

/** The host command line for `resolved`, or null when it should run here: off Flatpak, an app file, or no such program on the host (the caller then gets the same ENOENT as on a deb). */
export function hostBridge(
  resolved: ResolvedSpawn,
  context: { cwd?: string | URL; env?: NodeJS.ProcessEnv },
  processEnv: NodeJS.ProcessEnv = process.env,
): ResolvedSpawn | null {
  if (!inFlatpak(processEnv) || runsInSandbox(resolved.command)) return null;
  const env = { ...(context.env ?? processEnv), ...resolved.env };
  const found = hostFindCandidates(resolved.command, env.PATH ?? hostBasePath())[0];
  if (!found) return null;
  const cwd = typeof context.cwd === "string" && context.cwd ? context.cwd : undefined;
  return {
    command: FLATPAK_SPAWN,
    args: hostSpawnArgv({ command: found, args: resolved.args, cwd, env: { ...env, PATH: env.PATH ?? hostBasePath() } }),
    env: busEnv(processEnv),
  };
}

/** `flatpak-spawn` itself needs only the way to the session bus; everything else reaches the host child as --env. */
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
      ["--host", shell, "-l", "-i", "-c", 'printf "__OMB_PATH__%s" "$PATH"'],
      { timeout: HOST_PROBE_TIMEOUT_MS },
      (err, out) => {
        const match = err ? null : /__OMB_PATH__([^\n]*)/.exec(String(out ?? ""));
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
