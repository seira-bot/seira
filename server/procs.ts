// Windows differences for agent CLIs: CreateProcess cannot exec .cmd/.bat shims or shebang scripts (env-path
// resolves them without a shell), there is no process-group kill (taskkill /T), GUI-spawned consoles flash without
// windowsHide, and the command line is capped at 32,767 characters (prompts go on stdin or in files).
import {
  spawn,
  execFile,
  type ChildProcess,
  type ChildProcessByStdio,
  type ExecFileOptions,
  type SpawnOptions,
} from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { botBox, type WrappedSpawn } from "./bot-box/box.ts";
import { runnableInBox, type BoxRequest } from "./bot-box/plan.ts";
import { programsDistrusted, serverMayRunFrom, serverPath } from "./bot-box/program-trust.ts";
import { currentTurn } from "./crash-guard.ts";
import { engineMemory } from "./engine-memory.ts";
import { engineOwners } from "./engine-owners.ts";
import { ENGINE_TAG_ENV, engineRunTag, engineStopped, recordEngine } from "./engine-records.ts";
import { engineHomes } from "./engine-homes/engine-homes.ts";
import type { HomedSpawn } from "./engine-homes/layout.ts";
import { findCliCandidates, resolveCliSpawn, runnableFile, type ResolvedSpawn } from "./env-path.ts";
import { HOST_ENV_FD, hostBasePath, hostBridge, hostEnvFile, hostFindPrograms, inFlatpak, runsInSandbox, type HostSpawn } from "./flatpak-host.ts";
import { botMemoryGuard } from "./bot-memory-guard.ts";
import { memoryFence, type FencedSpawn } from "./memory-fence.ts";
import { spawnBotWork } from "./oom-score.ts";
import { noticeFailure } from "./chat-notices.ts";
import { processBudget } from "./process-room.ts";
import { shortageCode } from "./process-shortage.ts";

export function resolveCli(cli: string, args: string[] = [], env?: NodeJS.ProcessEnv): ResolvedSpawn {
  return resolveCliSpawn(cli, args, env);
}

/** Headroom below CreateProcess' 32,767 UTF-16 code-unit limit for libuv's quoting and executable expansion. */
export const WINDOWS_SAFE_COMMAND_LINE_CHARS = 30_000;

export function estimatedWindowsCommandLineChars(resolved: ResolvedSpawn): number {
  return [resolved.command, ...resolved.args].reduce(
    (total, value) => total + JSON.stringify(value).length + 1,
    0,
  );
}

export function assertSafeCliArgv(
  resolved: ResolvedSpawn,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") return;
  if (estimatedWindowsCommandLineChars(resolved) <= WINDOWS_SAFE_COMMAND_LINE_CHARS) return;
  const error = new Error(
    "agent CLI launch arguments exceed Windows' safe command-line limit; pass large prompts through stdin or a file",
  ) as NodeJS.ErrnoException;
  error.code = "ENAMETOOLONG";
  throw error;
}

// Only spawnCli makes a private POSIX group; a plain child may share ours, so never signal its group.
const cliGroups = new WeakSet<ChildProcess>();
const stopping = new WeakMap<ChildProcess, Promise<boolean>>();

type LinuxProcess = { pid: number; parent: number; start: string; state: string };
const linuxTrees = new WeakMap<ChildProcess, Map<number, string>>();

function linuxProcess(pid: number, file = `/proc/${pid}/stat`): LinuxProcess | null {
  let stat: string;
  try {
    stat = readFileSync(file, "utf8");
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const start = fields[19];
  const state = fields[0];
  const parent = Number(fields[1]);
  if (!start || !state || !Number.isInteger(parent)) throw new Error("Unreadable Linux process identity");
  return { pid, parent, start, state };
}

/** /proc/<pid>/task/<tid>/children needs CONFIG_PROC_CHILDREN (CONFIG_CHECKPOINT_RESTORE before Linux 4.2); a kernel built without it, or gVisor, has no such file. */
function linuxChildrenFiles(): boolean {
  return existsSync(`/proc/self/task/${process.pid}/children`);
}

/** Every thread's children, or null when the list may miss one: Linux hides /proc/<pid>/task once the main thread has
 * exited while others run, and a thread that exits hands its children to a sibling thread, after which its own
 * children file reads empty. */
function linuxChildren(pid: number): number[] | null {
  let tasks: string[];
  try { tasks = readdirSync(`/proc/${pid}/task`); } catch { return null; }
  if (tasks.length === 0) return null;
  const children: number[] = [];
  for (const task of tasks) {
    let listed: string;
    try { listed = readFileSync(`/proc/${pid}/task/${task}/children`, "utf8"); } catch { return null; }
    let thread: LinuxProcess | null;
    try { thread = linuxProcess(pid, `/proc/${pid}/task/${task}/stat`); } catch { return null; }
    if (!thread || thread.state === "Z" || thread.state === "X") return null;
    for (const entry of listed.split(" ")) if (/^\d+$/.test(entry)) children.push(Number(entry));
  }
  return children;
}

function isLinuxProcess(pid: number, start: string): boolean {
  try { return linuxProcess(pid)?.start === start; } catch { return false; }
}

/** Linux sandbox helpers can leave the CLI's process group and reparent during a protocol interrupt. */
export function captureCliTree(child: ChildProcess): void {
  if (process.platform !== "linux" || !cliGroups.has(child) || !child.pid) return;
  let tree = linuxTrees.get(child);
  if (!tree) {
    tree = new Map();
    linuxTrees.set(child, tree);
  }
  if (!linuxChildrenFiles() || !addLinuxDescendants(tree)) addLinuxDescendantsFromEveryProcess(tree);
}

/** False when the walk may have missed a descendant; those it confirmed stay in the tree. A children file can skip a
 * live child while a sibling listed before it is reaped (docs.kernel.org/filesystems/proc.html,
 * "/proc/<pid>/task/<tid>/children"), and that sibling is then gone or reparented when its stat is read. */
function addLinuxDescendants(tree: Map<number, string>): boolean {
  const queue = [...tree].filter(([pid, start]) => isLinuxProcess(pid, start));
  for (let next = 0; next < queue.length; next += 1) {
    const [parent, parentStart] = queue[next];
    const children = linuxChildren(parent);
    if (!children || !isLinuxProcess(parent, parentStart)) return false;
    for (const pid of children) {
      if (pid === process.pid) continue;
      let current: LinuxProcess | null;
      try { current = linuxProcess(pid); } catch { return false; }
      if (!current || current.parent !== parent) return false;
      if (tree.get(pid) === current.start) continue;
      tree.set(pid, current.start);
      queue.push([pid, current.start]);
    }
  }
  return true;
}

function addLinuxDescendantsFromEveryProcess(tree: Map<number, string>): void {
  const snapshot = new Map<number, LinuxProcess>();
  let entries: string[];
  try { entries = readdirSync("/proc"); } catch { return; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const current = linuxProcess(pid);
      if (current) snapshot.set(pid, current);
    } catch {}
  }
  const parents = new Set([...tree].filter(([pid, start]) => snapshot.get(pid)?.start === start).map(([pid]) => pid));
  let discovered: boolean;
  do {
    discovered = false;
    for (const current of snapshot.values()) {
      if (current.pid === process.pid || !parents.has(current.parent) || tree.get(current.pid) === current.start) continue;
      tree.set(current.pid, current.start);
      parents.add(current.pid);
      discovered = true;
    }
  } while (discovered);
}

function linuxDescendantsStopped(child: ChildProcess): boolean {
  for (const [pid, start] of linuxTrees.get(child) ?? []) {
    if (pid === child.pid) continue;
    try {
      const current = linuxProcess(pid);
      if (current?.start === start && current.state !== "Z" && current.state !== "X") return false;
    } catch { return false; }
  }
  return true;
}

/** Whether every process still in this group has exited and only waits to be collected. Where nothing collects orphans
 * (Node as a container's process 1) such members stay for good, and kill(-pgid, 0) goes on succeeding for them. False
 * when a member runs, when none is found, or when /proc can't say. */
export function linuxGroupOnlyExited(group: number, list: () => string[] = () => readdirSync("/proc"), stat: (pid: number) => string = (pid) => readFileSync(`/proc/${pid}/stat`, "utf8")): boolean {
  let entries: string[];
  try { entries = list(); } catch { return false; }
  let members = 0;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let fields: string[];
    try { const text = stat(Number(entry)); fields = text.slice(text.lastIndexOf(")") + 2).split(" "); } catch { continue; }
    if (Number(fields[2]) !== group) continue;
    if (fields[0] !== "Z" && fields[0] !== "X") return false;
    members += 1;
  }
  return members > 0;
}

function linuxRootIdentityMatches(child: ChildProcess): boolean | undefined {
  const start = child.pid && linuxTrees.get(child)?.get(child.pid);
  if (!child.pid || process.platform !== "linux" || !cliGroups.has(child)) return true;
  if (!start) return undefined;
  try {
    const current = linuxProcess(child.pid);
    return !current || current.start === start;
  } catch { return undefined; }
}

function signalLinuxDescendants(child: ChildProcess, value: NodeJS.Signals): void {
  for (const [pid, start] of [...(linuxTrees.get(child) ?? [])].reverse()) {
    if (pid === child.pid || pid <= 1 || pid === process.pid) continue;
    try {
      const current = linuxProcess(pid);
      if (current?.start === start && current.state !== "Z" && current.state !== "X") process.kill(pid, value);
    } catch {}
  }
}

const MAX_ENDED_SESSIONS = 4_096;
/** A fenced engine that exits with an error this soon may have failed to start inside the slice. */
const FAST_EXIT_MS = 3_000;
const engineSessions = { live: new Set<number>(), ended: new Set<number>() };

/** POSIX session ids of the engines that run bots' turns (each leads its own session). A server opened by any
 * process in one counts as the bot's, even after the shell that started it exits. */
export function botEngineSessions(): { live: ReadonlySet<number>; ended: ReadonlySet<number> } {
  return engineSessions;
}

function rememberEngineSession(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  engineSessions.live.add(pid);
  child.once("exit", () => {
    engineSessions.live.delete(pid);
    engineSessions.ended.add(pid);
    if (engineSessions.ended.size > MAX_ENDED_SESSIONS) engineSessions.ended.delete(engineSessions.ended.values().next().value!);
  });
}

const liveSpawns = new Set<readonly string[]>();

/** The command line of every process spawnCli started that has not exited yet. */
export function liveCliCommands(): Iterable<readonly string[]> {
  return liveSpawns;
}

function rememberLiveSpawn(child: ChildProcess, line: readonly string[]): void {
  if (!child.pid) return;
  liveSpawns.add(line);
  child.once("exit", () => liveSpawns.delete(line));
}

/** `bot`: an engine running bots' turns, whose own servers that bot's browser may open on a server host.
 * `seira`: everything else (logins, probes, the browser engine itself). */
export type CliOwner = "bot" | "seira";

/** The bot box (server/bot-box): a `bot` spawn runs in it where it is on; `box` asks for one for another owner, with more
 * paths or the host's network, and `false` keeps a spawn out of it. */
export interface BoxSpawnOptions {
  box?: boolean | Pick<BoxRequest, "rw" | "ro" | "net" | "botId" | "botThreads" | "allowEnv" | "relay" | "configured">;
  /** On a Team Cloud, runs in its conversation's engine home though it is not a bot's engine (a keep-warm ping). */
  engineHome?: boolean;
  /** A bot's own work that is not its engine (its browser, a helper engine): memory runs out on it first, as on a `bot`
   * spawn (oom-score.ts), with no box and no engine tracking. */
  botWork?: boolean;
}
export type CliSpawnOptions = SpawnOptions & BoxSpawnOptions;

/** The conversation and bot a spawn runs for: a Team Cloud's engine home, else the turn the driver runs. */
function spawnConversation(): { threadId?: string; conversationBot?: string } {
  const turn = currentTurn();
  const threadId = engineHomes.thread() ?? turn?.threadId, conversationBot = engineHomes.bot() ?? turn?.botId;
  return { ...(threadId ? { threadId } : {}), ...(conversationBot ? { conversationBot } : {}) };
}

/** The box for this spawn, or null when it runs as is. A spawn in an engine home has that home in place of HOME. */
export function boxedSpawn(resolved: ResolvedSpawn, opts: CliSpawnOptions, owner: CliOwner, homed: HomedSpawn | null = null): WrappedSpawn | null {
  if (opts.box === false || (owner !== "bot" && !opts.box)) return null;
  const request = typeof opts.box === "object" ? opts.box : {};
  const home = homed ? { home: homed.home, shared: homed.shared } : {};
  return botBox.wrap({ command: resolved.command, args: resolved.args, cwd: typeof opts.cwd === "string" ? opts.cwd : undefined, env: opts.env ?? process.env, ...spawnConversation(), ...request, ...home });
}

/** Looks a program up by name where an engine launched with `cli` will run it, with the PATH and the files it will have there. */
export interface ProgramView {
  find(name: string): string | undefined;
}

/** The view of a spawn of `cli` as `spawnCli` will make it: in the bot box (its PATH, and only the files its plan shows), on
 * the host a Flatpak launches from (the host's PATH and files), or on this computer without the folders the bots can write.
 * Null when that view cannot be known now, so the caller never guesses: in a box in a Flatpak (refused at the launch), and
 * in an engine home of a Team Cloud (made at the launch). Only a bare name is looked up, and only an absolute result for
 * this platform is given; empty and relative PATH entries are never searched. Outside the box a program is given only where
 * the launcher would start it: the file and where its links lead are judged by serverMayRunFrom (program-trust.ts). */
export function programViewFor(cli: string, opts: { cwd?: string; env: NodeJS.ProcessEnv; allowEnv?: string[] }): ProgramView | null {
  const absolute = (path: string | undefined) => (path ?? "").split(delimiter).filter((dir) => dir && isAbsolute(dir)).join(delimiter);
  const bare = (name: string) => Boolean(name) && !/[/\\\r\n]/.test(name) && !/^[a-zA-Z]:/.test(name);
  const view = (look: (name: string) => string | undefined): ProgramView => ({
    find: (name) => {
      const found = bare(name) ? look(name) : undefined;
      return found !== undefined && isAbsolute(found) ? found : undefined;
    },
  });
  const conversation = spawnConversation();
  const resolved = resolveCli(cli, [], opts.env);
  if (botBox.takes({ cwd: opts.cwd, ...conversation })) {
    if (inFlatpak() || (engineHomes.active() && engineHomes.thread() !== undefined)) return null;
    const seen = botBox.view({ command: resolved.command, args: [], cwd: opts.cwd, env: opts.env, ...conversation, ...(opts.allowEnv ? { allowEnv: opts.allowEnv } : {}) });
    if (!seen) return null;
    const path = absolute(seen.path);
    return view((name) => findCliCandidates(name, path).find((found) => runnableInBox(seen.plan, found, runnableFile)));
  }
  if (inFlatpak()) {
    // The host's own lookup tests each file there (flatpak-host.ts); an engine that runs inside the sandbox has another view.
    if (runsInSandbox(resolved.command)) return null;
    // As hostBridge does: the PATH the launcher would give, the first copy only, looked up afresh, kept off the host when
    // it or where it leads is a place the bots can write.
    const path = absolute(serverPath(opts.env.PATH ?? hostBasePath()));
    return view((name) => {
      const program = hostFindPrograms(name, path, true)[0];
      return program && program.real && serverMayRunFrom(program.path) && serverMayRunFrom(program.real) ? program.path : undefined;
    });
  }
  const path = absolute(programsDistrusted() ? serverPath(opts.env.PATH) : opts.env.PATH);
  return view((name) => {
    // The first file the launcher would start: when it is a place the bots can write, no later copy stands in for it.
    const found = findCliCandidates(name, path).find((candidate) => runnableFile(candidate) !== null);
    const real = found === undefined ? null : runnableFile(found);
    return found !== undefined && real !== null && serverMayRunFrom(found) && serverMayRunFrom(real) ? found : undefined;
  });
}

/** What the audience rule and the bot's folders give a box in `cwd` now, as a key (null off a team with no folder
 * setting, or for a spawn the box does not take): a process kept between turns is started again when it changes, such
 * as a bot's "Can edit team files" or "Only chosen folders". */
export function boxAudienceKey(cwd: string): string | null {
  const request = { cwd, ...spawnConversation() };
  return botBox.takes(request) ? botBox.audienceKey(request) : null;
}

/** What a process several conversations share must be boxed with to serve `cwd` (null for a spawn the box does not
 * take): all of the bot's conversation folders for a conversation folder (task-workspaces/<bot>/<thread>,
 * BoxRequest.botThreads), on a Team Cloud only those its audience may read (BoxAudience.threads), else `cwd`. */
export function sharedBoxScope(cwd: string): string | null {
  const request = { cwd, ...spawnConversation() };
  if (!botBox.takes(request)) return null;
  const parent = dirname(resolve(cwd));
  if (basename(dirname(parent)) !== "task-workspaces") return resolve(cwd);
  const threads = botBox.sharedThreadsKey(request);
  return threads ? `${parent}#${createHash("sha256").update(threads).digest("hex").slice(0, 16)}` : parent;
}

/** Security (bot-box/program-trust.ts): a spawn outside the box neither starts a program from a folder a boxed bot can
 * write nor looks one up there. */
export function outsideBoxOptions<T extends { env?: NodeJS.ProcessEnv; cwd?: string | URL }>(command: string, opts: T): T {
  if (!programsDistrusted()) return opts;
  const env = opts.env ?? process.env;
  const path = serverPath(env.PATH);
  // A program found by name is checked as well: the folder can be trusted while a link in it leads to one the bots write.
  const program = !/[/\\]/.test(command) ? onPath(command, path) : isAbsolute(command) ? command : `${spawnCwd(opts.cwd)}${sep}${command}`;
  if (program && (!serverMayRunFrom(program) || !serverMayRunFrom(realPathOr(program)))) {
    throw Object.assign(new Error(`${command} is in a folder the bots can write, so the server does not run it outside the bot box.`), { code: "EACCES" });
  }
  return { ...opts, env: { ...env, PATH: path } };
}

function realPathOr(path: string): string {
  try { return realpathSync.native(path); } catch { return path; }
}

/** The folder a spawn with `cwd` starts in. */
function spawnCwd(cwd: string | URL | undefined): string {
  const dir = cwd instanceof URL ? fileURLToPath(cwd) : cwd ?? process.cwd();
  return isAbsolute(dir) ? dir : `${process.cwd()}${sep}${dir}`;
}

/** The file a spawn of `command` by name starts, on `path`, named as the system opens it: unnormalized, because a `..`
 * after a link goes up from where the link leads. */
function onPath(command: string, path: string): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const file = `${dir}${sep}${command}`;
    try {
      accessSync(file, constants.X_OK);
      if (statSync(file).isFile()) return file;
    } catch {}
  }
  return null;
}

/** `stdio` with the descriptor `envFd` at HOST_ENV_FD, where `flatpak-spawn` reads the child's environment. */
export function hostStdio(stdio: SpawnOptions["stdio"], envFd: number): NonNullable<SpawnOptions["stdio"]> {
  const base = Array.isArray(stdio) ? stdio.slice(0, 3) : [stdio ?? "pipe", stdio ?? "pipe", stdio ?? "pipe"];
  while (base.length < HOST_ENV_FD) base.push("pipe");
  return [...base, envFd] as NonNullable<SpawnOptions["stdio"]>;
}

export function spawnCli(
  cli: string,
  args: string[],
  opts: CliSpawnOptions,
  owner: CliOwner = "seira",
): ChildProcessByStdio<Writable, Readable, Readable> {
  const resolved = resolveCli(cli, args);
  assertSafeCliArgv(resolved);
  const homed = owner === "bot" || opts.engineHome ? engineHomes.forSpawn(opts.env ?? process.env) : null;
  const env = homed?.env ?? opts.env;
  const options: CliSpawnOptions = resolved.env
    ? { ...opts, env: { ...(env ?? process.env), ...resolved.env } }
    : homed ? { ...opts, env } : opts;
  // A server that restarts in place stops what an earlier one left by this tag (engine-records.ts).
  const tag = process.platform === "win32" ? null : engineRunTag();
  const boxed = boxedSpawn(resolved, options, owner, homed);
  // The box's command, broker and bridge are paths of this sandbox, which the host does not have: a boxed spawn cannot run there.
  if (boxed && inFlatpak()) {
    for (const fd of boxed.extraFds) try { closeSync(fd); } catch {}
    boxed.release();
    throw Object.assign(new Error("Bots cannot run in a protected box in this version of Seira."), { code: "EACCES" });
  }
  // In a Flatpak a spawn the deb would also run outside the box starts on the host (flatpak-host.ts).
  const hosted = boxed ? null : hostBridge(resolved, { cwd: options.cwd, env: tag ? { ...(options.env ?? process.env), [ENGINE_TAG_ENV]: tag } : options.env });
  const { box: _box, engineHome: _engineHome, botWork, ...spawnOpts } = boxed || hosted ? options : outsideBoxOptions(resolved.command, options);
  // The box's extra descriptors (its seccomp filter) follow stdio; only a plain three-entry stdio can take them.
  const stdio = boxed?.extraFds.length && Array.isArray(spawnOpts.stdio) && spawnOpts.stdio.length === 3 ? [...spawnOpts.stdio, ...boxed.extraFds] : spawnOpts.stdio;
  const command = boxed?.command ?? hosted?.command ?? resolved.command, argv = boxed?.args ?? hosted?.args ?? resolved.args;
  const plainEnv = tag ? { ...(boxed?.env ?? spawnOpts.env ?? process.env), [ENGINE_TAG_ENV]: tag } : boxed?.env ?? spawnOpts.env ?? process.env;
  let fenced: FencedSpawn | null = null;
  const start = () => {
    const envFd = hosted ? hostEnvFile(hosted.envBlock) : null;
    try {
      return spawn(fenced?.command ?? command, fenced?.args ?? argv, {
        ...spawnOpts,
        ...(boxed ? { env: boxed.env, stdio } : {}),
        ...(tag ? { env: plainEnv } : {}),
        ...(fenced ? { env: fenced.env } : {}),
        ...(hosted && envFd !== null ? { env: hosted.env, cwd: undefined, stdio: hostStdio(spawnOpts.stdio, envFd) } : {}),
        // POSIX: own group so kill(-pid) reaps child MCP servers; Windows: taskkill /T does it.
        ...(process.platform === "win32" ? { windowsHide: true } : { detached: true }),
      }) as ChildProcessByStdio<Writable, Readable, Readable>;
    } finally {
      if (envFd !== null) try { closeSync(envFd); } catch {}
    }
  };
  let child: ChildProcessByStdio<Writable, Readable, Readable>;
  const refused = (code: string | undefined) => { processBudget.spawnFailed(code); engineMemory.spawnRefused(code, owner === "bot"); };
  try {
    // Not inside `start`: there the server holds the bot's OOM score, and the fence runs systemctl.
    fenced = !hosted && (owner === "bot" || botWork) ? (process.platform === "linux" ? memoryFence : botMemoryGuard).argv(command, argv, plainEnv) : null;
    child = owner === "bot" || botWork ? spawnBotWork(start) : start();
  } catch (error) {
    // Node throws some refusals (ENOMEM) at once rather than reporting them on the child.
    if (shortageCode(error)) refused((error as NodeJS.ErrnoException).code);
    throw error;
  } finally {
    for (const fd of boxed?.extraFds ?? []) try { closeSync(fd); } catch {}
  }
  if (fenced && process.platform === "linux") {
    const spawnedAt = Date.now();
    child.once("exit", (code) => { if (code !== null && code !== 0 && Date.now() - spawnedAt < FAST_EXIT_MS) memoryFence.recheck(); });
  }
  rememberLiveSpawn(child, [resolved.command, ...resolved.args]);
  // Node reports most refused spawns (EAGAIN, EMFILE, ENOENT) on the child, a tick later, with no pid.
  child.once("error", (error: NodeJS.ErrnoException) => { if (!child.pid) refused(error.code); });
  // The broker token minted for this process dies with it.
  if (boxed?.token) child.once("exit", boxed.release);
  if (process.platform !== "win32") cliGroups.add(child);
  if (process.platform === "linux" && child.pid) {
    const tree = new Map<number, string>();
    try {
      const root = linuxProcess(child.pid);
      if (root) tree.set(root.pid, root.start);
    } catch {}
    linuxTrees.set(child, tree);
  }
  if (process.platform !== "win32") recordEngine(child, child.pid ? linuxTrees.get(child)?.get(child.pid) ?? null : null);
  if (owner === "bot") {
    if (process.platform !== "win32") rememberEngineSession(child);
    engineMemory.track(child);
    engineOwners.track(child, child.pid ? linuxTrees.get(child)?.get(child.pid) ?? null : null);
  }

  // On Windows a stdin write between taskkill and pipe close errors asynchronously; unlistened, that crashes the harness.
  child.stdin?.on("error", () => {});
  return child;
}

/** execCli's answer for a spawn that runs in the bot box where it is on (`box`), as a bot's own would: an engine's
 * status or catalog read that loads the engine's settings, extensions or MCP servers from a HOME a bot can write. */
export function execCliBoxed(
  cli: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv | Record<string, string | undefined>; cwd?: string; timeout: number; maxBuffer?: number; box: NonNullable<BoxSpawnOptions["box"]> },
  cb: (err: (Error & { code?: number | string | null; killed?: boolean }) | null, stdout: string, stderr: string) => void,
): void {
  const limit = opts.maxBuffer ?? 1024 * 1024;
  let child: ChildProcessByStdio<Writable, Readable, Readable>;
  try {
    child = spawnCli(cli, args, { env: opts.env as NodeJS.ProcessEnv, cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], box: opts.box });
  } catch (error) {
    queueMicrotask(() => cb(error instanceof Error ? error : new Error(String(error)), "", ""));
    return;
  }
  child.stdin.end();
  let stdout = "", stderr = "", done = false, timedOut = false;
  const finish = (err: (Error & { code?: number | string | null; killed?: boolean }) | null) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    cb(err, stdout, stderr);
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { if (stdout.length < limit) stdout += chunk.slice(0, limit - stdout.length); });
  child.stderr.on("data", (chunk: string) => { if (stderr.length < limit) stderr += chunk.slice(0, limit - stderr.length); });
  const timer = setTimeout(() => {
    timedOut = true;
    void killCliTree(child, 0);
  }, opts.timeout);
  timer.unref?.();
  child.once("error", (error) => finish(error));
  child.once("close", (code) => {
    if (timedOut) finish(cutOffError(cli, opts.timeout));
    else finish(code === 0 ? null : Object.assign(new Error(`${cli} exited with code ${code}`), { code }));
  });
}

const EXEC_KILL_GRACE_MS = 2_000;

/** execFile for a program on the host: `execFile` cannot pass the descriptor that carries the environment, so this reads the output itself. */
function execHosted(hosted: HostSpawn, opts: ExecFileOptions, done: (err: Error | null, stdout: string, stderr: string) => void): ChildProcess {
  const limit = typeof opts.maxBuffer === "number" ? opts.maxBuffer : 1024 * 1024;
  const envFd = hostEnvFile(hosted.envBlock);
  let child: ChildProcess;
  try {
    child = spawn(hosted.command, hosted.args, { env: hosted.env, stdio: ["ignore", "pipe", "pipe", envFd], windowsHide: true });
  } finally {
    try { closeSync(envFd); } catch {}
  }
  let stdout = "", stderr = "", finished = false, overflow = false;
  const finish = (err: Error | null) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    done(err, stdout, stderr);
  };
  const take = (current: string, chunk: string) => {
    if (current.length + chunk.length > limit) {
      overflow = true;
      child.kill("SIGTERM");
    }
    return current.length < limit ? current + chunk.slice(0, limit - current.length) : current;
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { stdout = take(stdout, chunk); });
  child.stderr?.on("data", (chunk: string) => { stderr = take(stderr, chunk); });
  const timer = opts.timeout ? setTimeout(() => child.kill("SIGTERM"), opts.timeout) : undefined;
  timer?.unref?.();
  child.once("error", (error) => finish(error));
  child.once("close", (code, signal) => {
    if (overflow) return finish(Object.assign(new Error("stdout maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }));
    if (code === 0) return finish(null);
    finish(Object.assign(new Error(`Command failed: ${hosted.command}`), { code, signal, killed: child.killed }));
  });
  return child;
}

export function execCli(
  cli: string,
  args: string[],
  opts: ExecFileOptions,
  cb: (err: Error | null, stdout: string, stderr?: string) => void,
): void {
  const resolved = resolveCli(cli, args);
  let hosted: HostSpawn | null = null;
  try {
    assertSafeCliArgv(resolved);
    hosted = hostBridge(resolved, { cwd: opts.cwd, env: opts.env });
    if (!hosted) opts = outsideBoxOptions(resolved.command, opts);
  } catch (error) {
    queueMicrotask(() => cb(error instanceof Error ? error : new Error(String(error)), "", ""));
    return;
  }
  let escalate: NodeJS.Timeout | undefined;
  let deadline: NodeJS.Timeout | undefined;
  let timedOut = false;
  const env = hosted ? hosted.env : resolved.env ? { ...(opts.env ?? process.env), ...resolved.env } : opts.env;
  const done = (err: Error | null, stdout: string, stderr: string) => {
    clearTimeout(escalate);
    clearTimeout(deadline);
    cb(err ?? (timedOut ? cutOffError(cli, opts.timeout) : null), stdout, stderr);
  };
  const child = hosted
    ? execHosted(hosted, opts, done)
    : execFile(resolved.command, resolved.args, { ...opts, env, windowsHide: true, encoding: "utf8" }, done);
  // Node (24) calls back only once the child exits, and a CLI wrapper that traps SIGTERM outlives the timeout's signal.
  // Only the child is stopped: execFile starts no process group, so a grandchild that ignores SIGTERM can outlive it.
  // When its timeout fires after the child exited but before Node saw the exit, Node (24) drops the output and still
  // reports success; this timer is queued just after Node's, so it marks that run as timed out.
  if (opts.timeout) {
    escalate = setTimeout(() => void killCliTree(child, 0), opts.timeout + EXEC_KILL_GRACE_MS);
    escalate.unref?.();
    deadline = setTimeout(() => {
      timedOut = true;
    }, opts.timeout);
    deadline.unref?.();
  }
}

function cutOffError(cli: string, timeout: number | undefined): Error {
  return Object.assign(new Error(`${cli} timed out after ${timeout} ms`), { killed: true, code: null, signal: null });
}

export const CLI_VERSION_TIMEOUT_MS = 30_000;

export function cliVersionReader(cli: string): (err: Error | null, stdout: string) => { version: string } | { reason: string } {
  let last: string | null = null;
  return (err, stdout) => {
    const version = err ? "" : stdout.trim();
    if (version) return { version: (last = version) };
    const failure = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
    const timedOut = failure?.killed === true && typeof failure.code !== "string";
    if (failure?.code === "ENOENT") {
      last = null;
      return { reason: `\`${cli}\` CLI not found` };
    }
    if (failure?.code === "EACCES" || failure?.code === "EPERM") {
      last = null;
      return { reason: `\`${cli}\` could not run --version. Check its file permissions.` };
    }
    if (last && (timedOut || !err || typeof failure?.code === "number")) return { version: last };
    return { reason: timedOut
      ? `\`${cli}\` took longer than ${CLI_VERSION_TIMEOUT_MS / 1000} seconds to answer --version. The machine may be busy; check again.`
      : !err ? `\`${cli}\` returned no version. Check again.` : `\`${cli}\` could not report its version. Check that it starts in a terminal, then check again.` };
  };
}

/** Node reports a missing cwd as the CLI's own ENOENT, so pass `cwd` to tell a moved folder from a missing CLI. */
type SpawnFailure = { message: string; setup: boolean; text?: ReturnType<typeof noticeFailure>["text"] };

export function describeSpawnFailure(err: NodeJS.ErrnoException, cli: string, cwd?: string): SpawnFailure {
  const shortage = shortageCode(err);
  if (shortage) return { ...noticeFailure("chat.notice.outOfProcesses", { code: shortage }), setup: false };
  if (err.code === "ENOENT") {
    if (cwd && !existsSync(cwd))
      return { message: `This chat's working folder no longer exists: ${cwd}. Choose another folder in the bot's settings, or create it again.`, setup: false };
    return { message: `\`${cli}\` isn't installed, or isn't on this app's PATH`, setup: true };
  }
  if (err.code === "EACCES" || err.code === "EPERM")
    return { message: `\`${cli}\` isn't executable — check its file permissions`, setup: true };
  if (err.code === "ENAMETOOLONG")
    return {
      message: `\`${cli}\` received too much launch data for Windows; update this provider or pass its prompt through stdin/a file`,
      setup: false,
    };
  return { message: `spawn failed: ${err.message}`, setup: false };
}

/** timeoutMs is the TERM grace; SIGKILL gets one more second. Linux also stops captured detached descendants. */
export function killCliTree(child: ChildProcess, timeoutMs = 5_000): Promise<boolean> {
  const existing = stopping.get(child);
  if (existing) return existing;
  const pid = child.pid;
  if (!pid) return Promise.resolve(true);
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return Promise.resolve(false);

  captureCliTree(child);
  const run = stopCliTree(child, pid, Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 5_000);
  stopping.set(child, run);
  // Remember success, so a delayed caller cannot signal a reused PID/group.
  void run.then((stopped) => { if (!stopped) stopping.delete(child); else engineStopped(child); });
  return run;
}

async function stopCliTree(child: ChildProcess, pid: number, timeoutMs: number): Promise<boolean> {
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (process.platform !== "win32") {
    const group = cliGroups.has(child);
    const settled = () => {
      if (!exited() || !linuxDescendantsStopped(child)) return false;
      if (!group || linuxRootIdentityMatches(child) === false) return true;
      if (linuxRootIdentityMatches(child) === undefined) return false;
      try {
        process.kill(-pid, 0);
        return process.platform === "linux" && linuxGroupOnlyExited(pid);
      } catch (error) {
        // EPERM and other failures do not prove that the group is gone.
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    };
    const signal = (value: NodeJS.Signals) => {
      captureCliTree(child);
      signalLinuxDescendants(child, value);
      try {
        if (group && (!exited() || linuxRootIdentityMatches(child) === true)) process.kill(-pid, value);
        else if (!group && !exited()) child.kill(value);
      } catch {
        if (!exited()) {
          try { child.kill(value); } catch {}
        }
      }
    };
    const wait = async (ms: number) => {
      const deadline = Date.now() + ms;
      while (!settled()) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          // Timers run before libuv's poll phase reads SIGCHLD: a blocked loop reaches the deadline with the exit unread.
          await new Promise((resolve) => setImmediate(resolve));
          return settled();
        }
        await exitOrDelay(child, Math.min(25, remaining));
      }
      return true;
    };
    if (settled()) return true;
    if (exited()) processBudget.noteLateReaped();
    signal("SIGTERM");
    if (await wait(timeoutMs)) return true;
    processBudget.noteForceKilled();
    signal("SIGKILL");
    return wait(1_000);
  }

  if (exited()) return true;

  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;
    let finished = false;
    const done = (stopped: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.off("close", closed);
      child.off("exit", closed);
      resolve(stopped);
    };
    const closed = () => done(true);
    child.once("close", closed);
    timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();

    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (err) => {
      if (finished) return;
      if (!err) {
        // taskkill can finish before Node sees the exit, and callers may rename the executable at once: wait for both, not for inherited pipes.
        if (exited()) done(true);
        else child.once("exit", closed);
        return;
      }
      try {
        child.kill();
      } catch {
      }
      // taskkill /T also fails when one process in the tree could not be stopped; that one may still hold the pipes the CLI
      // inherited, so "close" never comes. The CLI itself exiting is what counts.
      if (exited()) done(true);
      else child.once("exit", closed);
    });
  });
}

function exitOrDelay(child: ChildProcess, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      child.off("exit", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    child.once("exit", done);
  });
}

/** True once the process itself has exited, within `ms`; members it left in its group are not counted. */
export async function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const deadline = Date.now() + ms;
  while (!exited() && Date.now() < deadline) await exitOrDelay(child, Math.min(250, deadline - Date.now()));
  if (!exited()) await new Promise((resolve) => setImmediate(resolve));
  return exited();
}

/** Unix socket on POSIX, named pipe on Windows (Node cannot listen on a filesystem socket path there: EACCES). */
export function brokerSocketPath(dataDir: string, tag: string): string {
  return process.platform === "win32"
    // Named pipes share a global namespace that DATA_DIR cannot isolate.
    ? `\\\\.\\pipe\\seira-perm-${process.pid}-${tag}`
    : join(dataDir, `perm-${tag}.sock`);
}
