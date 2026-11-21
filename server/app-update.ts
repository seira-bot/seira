// The updater of an npm install. A new version is installed as a copy in `<data dir>/app/<version>`, the data is backed up
// by the launcher once the server has stopped, and the launcher (server/app-handoff.ts) starts the copy. Nothing here
// deletes a person's data: a restore moves what is there aside into `.backups/update/failed-<time>/`.
//
// SECURITY: a copy is run only when `state.json` names a version `X.Y.Z` and the folder `<data dir>/app/<version>` exactly.
// The file belongs to the server's user, and so does everything that could write it.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { delimiter, join, sep } from "node:path";

import type { ServerUpdateReason, ServerUpdateRun } from "../shared/server-update.ts";
import { ensurePrivateDir } from "./data-dir.ts";
import { isNewerVersion } from "./update-check.ts";

export const APP_DIR = "app";
export const APP_PACKAGE = "@seira-bot/seira";
export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const STATE_FILE = "state.json";
const BACKUP_DIR = join(".backups", "update");
/** Top-level folders of the data folder that a backup leaves out and a restore leaves alone. */
const LEFT_ALONE = ["app", "tools", "logs", ".backups"] as const;
export const KEEP_COPIES = 2;
export const KEEP_BACKUPS = 2;
export const INSTALL_TIMEOUT_MS = 10 * 60_000;
const VERIFY_TIMEOUT_MS = 60_000;
const ARCHIVE_TIMEOUT_MS = 60 * 60_000;
/** An update that has not finished after this long did not start; a new one may be made. */
export const STALE_PENDING_MS = 2 * 60 * 60_000;

export type UpdateBy = "admin" | "automatic";

export interface AppCopyRef { version: string; dir: string }
export interface PendingApp { from: string; to: string; dir: string; backup?: string; at: number; by: UpdateBy }
export interface AppState {
  current?: AppCopyRef;
  pending?: PendingApp;
  /** Versions that did not work on this server; none is tried again by itself. */
  failed: string[];
  last?: ServerUpdateRun;
}

export interface ExecResult { code: number | null; out: string }
export type Exec = (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<ExecResult>;

export function realExec(): Exec {
  return (command, args, options) => new Promise((resolve) => {
    let out = "";
    let finished = false;
    const done = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ code, out });
    };
    let child;
    try {
      child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" && command.endsWith(".cmd") });
    } catch {
      return resolve({ code: null, out: "" });
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null);
    }, options.timeoutMs);
    const keep = (chunk: Buffer) => { if (out.length < 16_384) out += chunk.toString("utf8", 0, 16_384); };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.on("error", () => done(null));
    child.on("close", (code) => done(code));
  });
}

export interface AppUpdateDeps {
  exec: Exec;
  now(): number;
  npmOnPath(): boolean;
  freeBytes(dir: string): number;
  dataBytes(dataDir: string): Promise<number>;
  node: string;
}

export function npmOnPath(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): boolean {
  const names = process.platform === "win32" ? ["npm.cmd", "npm.exe"] : ["npm"];
  return (env.PATH ?? "").split(delimiter).filter(Boolean).some((folder) => names.some((name) => exists(join(folder, name))));
}

export function freeBytes(dir: string): number {
  try {
    const stats = statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** The size of what a backup keeps. */
export async function dataBytes(dataDir: string): Promise<number> {
  const skipped = new Set(["app", "tools", "logs", join(".backups", "update")]);
  let total = 0;
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const next = rel ? join(rel, entry.name) : entry.name;
      if (skipped.has(next)) continue;
      if (entry.isDirectory()) await walk(join(dir, entry.name), next);
      else {
        try { total += (await lstat(join(dir, entry.name))).size; } catch { /* gone */ }
      }
    }
  };
  await walk(dataDir, "");
  return total;
}

export function realDeps(): AppUpdateDeps {
  return { exec: realExec(), now: Date.now, npmOnPath: () => npmOnPath(), freeBytes, dataBytes, node: process.execPath };
}

export const appRoot = (dataDir: string): string => join(dataDir, APP_DIR);
export const copyDir = (dataDir: string, version: string): string => join(appRoot(dataDir), version);
export const copyCli = (dir: string): string => join(dir, "node_modules", ...APP_PACKAGE.split("/"), "cli.js");
export const backupFolder = (dataDir: string): string => join(dataDir, BACKUP_DIR);

function text(value: unknown): value is string {
  return typeof value === "string";
}

function parseRef(raw: unknown): AppCopyRef | undefined {
  const ref = raw as Partial<AppCopyRef> | null;
  return ref && text(ref.version) && text(ref.dir) && VERSION_PATTERN.test(ref.version) ? { version: ref.version, dir: ref.dir } : undefined;
}

export function readAppState(dataDir: string): AppState {
  try {
    const raw = JSON.parse(readFileSync(join(appRoot(dataDir), STATE_FILE), "utf8")) as Record<string, unknown>;
    const current = parseRef(raw.current);
    const p = raw.pending as Partial<PendingApp> | undefined;
    const to = parseRef({ version: p?.to, dir: p?.dir });
    const pending: PendingApp | undefined = p && to && text(p.from) && VERSION_PATTERN.test(p.from) && typeof p.at === "number" && (p.by === "admin" || p.by === "automatic")
      ? { from: p.from, to: to.version, dir: to.dir, at: p.at, by: p.by, ...(text(p.backup) && p.backup ? { backup: p.backup } : {}) }
      : undefined;
    const failed = Array.isArray(raw.failed) ? raw.failed.filter((version): version is string => text(version) && VERSION_PATTERN.test(version)) : [];
    const l = raw.last as Partial<ServerUpdateRun> | undefined;
    const last = l && text(l.outcome) && text(l.from) && typeof l.at === "number" ? l as ServerUpdateRun : undefined;
    return { ...(current ? { current } : {}), ...(pending ? { pending } : {}), failed, ...(last ? { last } : {}) };
  } catch {
    return { failed: [] };
  }
}

export function writeAppState(dataDir: string, state: AppState): void {
  const root = appRoot(dataDir);
  ensurePrivateDir(root);
  const file = join(root, STATE_FILE);
  writeFileSync(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

export function changeAppState(dataDir: string, change: (state: AppState) => AppState): AppState {
  const next = change(readAppState(dataDir));
  writeAppState(dataDir, next);
  return next;
}

/** The CLI of a recorded copy, or null when it is not exactly `<data dir>/app/<version>` or has no CLI. */
export function validCopy(dataDir: string, ref: AppCopyRef | undefined): string | null {
  if (!ref || !VERSION_PATTERN.test(ref.version) || ref.dir !== copyDir(dataDir, ref.version)) return null;
  const cli = copyCli(ref.dir);
  try {
    const root = realpathSync(appRoot(dataDir));
    const real = realpathSync(cli);
    return real.startsWith(root + sep) && statSync(real).isFile() ? cli : null;
  } catch {
    return null;
  }
}

/** The version of the copy under `<data dir>/app/` that holds `script`, when it is one. */
export function runningCopy(dataDir: string, script: string | undefined): string | undefined {
  if (!script) return undefined;
  try {
    const root = realpathSync(appRoot(dataDir));
    const real = realpathSync(script);
    if (!real.startsWith(root + sep)) return undefined;
    const version = real.slice(root.length + 1).split(sep)[0];
    return version && VERSION_PATTERN.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

function versionOrder(a: string, b: string): number {
  return isNewerVersion(a, b) ? -1 : isNewerVersion(b, a) ? 1 : 0;
}

/** At most KEEP_COPIES copies and KEEP_BACKUPS backups stay, never the current, the pending or the running one. */
export function prune(dataDir: string, running?: string): void {
  const state = readAppState(dataDir);
  const protectedVersions = new Set([state.current?.version, state.pending?.to, running].filter((version): version is string => Boolean(version)));
  const root = appRoot(dataDir);
  let names: string[] = [];
  try { names = readdirSync(root); } catch { /* none yet */ }
  const copies = names.filter((name) => VERSION_PATTERN.test(name)).sort(versionOrder);
  for (const name of names.filter((n) => n.startsWith(".tmp-"))) rmSync(join(root, name), { recursive: true, force: true });
  let kept = copies.filter((name) => protectedVersions.has(name)).length;
  for (const name of copies) {
    if (protectedVersions.has(name)) continue;
    if (kept < KEEP_COPIES) { kept++; continue; }
    rmSync(join(root, name), { recursive: true, force: true });
  }
  const folder = backupFolder(dataDir);
  let archives: string[] = [];
  try { archives = readdirSync(folder).filter((name) => name.endsWith(".tgz")); } catch { /* none yet */ }
  const newest = archives.map((name) => ({ name, at: statSync(join(folder, name)).mtimeMs })).sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1));
  const keepNames = new Set(newest.slice(0, KEEP_BACKUPS).map((entry) => entry.name));
  if (state.pending?.backup) keepNames.add(state.pending.backup.split(sep).pop() ?? "");
  for (const { name } of newest) if (!keepNames.has(name)) rmSync(join(folder, name), { force: true });
}

export type InstallResult = { ok: true; dir: string } | { ok: false };

/** npm into a folder that does not count, a check that the copy runs and names the version, then a rename. */
export async function installCopy(dataDir: string, version: string, deps: AppUpdateDeps): Promise<InstallResult> {
  if (!VERSION_PATTERN.test(version)) return { ok: false };
  const root = appRoot(dataDir);
  ensurePrivateDir(root);
  const at = deps.now();
  const target = copyDir(dataDir, version);
  const temp = join(root, `.tmp-${version}-${at}`);
  const scratch = join(root, `.tmp-verify-${at}`);
  const names = async (cli: string) => (await deps.exec(deps.node, [cli, "--version"], { env: { ...process.env, SEIRA_DATA_DIR: scratch }, timeoutMs: VERIFY_TIMEOUT_MS })).out.trim();
  const existing = validCopy(dataDir, { version, dir: target });
  try {
    if (existing && await names(existing) === version) return { ok: true, dir: target };
    mkdirSync(temp, { recursive: true, mode: 0o700 });
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const installed = await deps.exec(npm, ["install", "--prefix", temp, `${APP_PACKAGE}@${version}`, "--no-audit", "--no-fund", "--omit=dev"], { timeoutMs: INSTALL_TIMEOUT_MS });
    const cli = copyCli(temp);
    if (installed.code !== 0 || !existsSync(cli) || await names(cli) !== version) return { ok: false };
    rmSync(target, { recursive: true, force: true });
    renameSync(temp, target);
    return { ok: true, dir: target };
  } finally {
    rmSync(temp, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

export type BackupResult = { ok: true; file: string } | { ok: false };

/** Run only when the server has stopped. A tar.gz of the data folder without app/, tools/, logs/ and the update backups. */
export async function backupData(dataDir: string, from: string, deps: AppUpdateDeps): Promise<BackupResult> {
  const folder = backupFolder(dataDir);
  ensurePrivateDir(join(dataDir, ".backups"));
  ensurePrivateDir(folder);
  const file = join(folder, `${from}-${deps.now()}.tgz`);
  const made = await deps.exec("tar", ["-czf", file, "--exclude=./app", "--exclude=./tools", "--exclude=./logs", "--exclude=./.backups/update", "-C", dataDir, "."], { timeoutMs: ARCHIVE_TIMEOUT_MS });
  if (made.code !== 0) {
    rmSync(file, { force: true });
    return { ok: false };
  }
  const listed = await deps.exec("tar", ["-tzf", file], { timeoutMs: ARCHIVE_TIMEOUT_MS });
  if (listed.code !== 0) {
    rmSync(file, { force: true });
    return { ok: false };
  }
  try { chmodSync(file, 0o600); } catch { /* the folder is private */ }
  return { ok: true, file };
}

export type RestoreResult = { ok: true; aside: string } | { ok: false; changed: boolean };

/** The backup comes back; what was there moves to `.backups/update/failed-<time>/`. Nothing is deleted. */
export async function restoreData(dataDir: string, file: string, deps: AppUpdateDeps): Promise<RestoreResult> {
  const folder = backupFolder(dataDir);
  const stage = join(folder, `restore-${deps.now()}`);
  const aside = join(folder, `failed-${deps.now()}`);
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  const extracted = await deps.exec("tar", ["-xzf", file, "-C", stage], { timeoutMs: ARCHIVE_TIMEOUT_MS });
  if (extracted.code !== 0) return { ok: false, changed: false };
  mkdirSync(aside, { recursive: true, mode: 0o700 });
  const left = (name: string) => (LEFT_ALONE as readonly string[]).includes(name);
  let changed = false;
  try {
    for (const name of readdirSync(dataDir)) {
      if (left(name)) continue;
      changed = true;
      renameSync(join(dataDir, name), join(aside, name));
    }
    for (const name of readdirSync(stage)) {
      if (left(name)) continue;
      renameSync(join(stage, name), join(dataDir, name));
    }
  } catch {
    return { ok: false, changed };
  }
  rmSync(stage, { recursive: true, force: true });
  try { rmdirSync(aside); } catch { /* it holds what was moved aside */ }
  return { ok: true, aside };
}

export type PrepareResult = { ok: true; pending: PendingApp } | { ok: false; reason: ServerUpdateReason | "busy" };

/**
 * The part of an update that runs while the server still serves: the checks, then the copy. The launcher takes the backup
 * once the server has stopped, so the copy of the data is whole.
 */
export async function prepareUpdate(input: { dataDir: string; from: string; to: string; by: UpdateBy; running?: string }, deps: AppUpdateDeps): Promise<PrepareResult> {
  const { dataDir, from, to, by } = input;
  const refuse = (reason: ServerUpdateReason | "busy"): PrepareResult => {
    if (reason !== "busy") changeAppState(dataDir, (state) => ({ ...state, last: { outcome: "not-changed", reason, from, at: deps.now(), ...(by === "automatic" ? { automatic: true } : {}), local: true } }));
    return { ok: false, reason };
  };
  if (!VERSION_PATTERN.test(from) || !VERSION_PATTERN.test(to) || !isNewerVersion(to, from)) return refuse("older");
  const open = readAppState(dataDir).pending;
  if (open && deps.now() - open.at < STALE_PENDING_MS) return refuse("busy");
  if (!deps.npmOnPath()) return refuse("no-updater");
  ensurePrivateDir(dataDir);
  if (deps.freeBytes(dataDir) < 2 * await deps.dataBytes(dataDir)) return refuse("no-room");
  prune(dataDir, input.running);
  const installed = await installCopy(dataDir, to, deps);
  if (!installed.ok) return refuse("failed");
  const pending: PendingApp = { from, to, dir: installed.dir, at: deps.now(), by };
  changeAppState(dataDir, (state) => ({ ...state, pending }));
  return { ok: true, pending };
}
