import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import module from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { serverChildLaunch } from "./server-child-launch.mjs";

const bootstrapSource = fileURLToPath(new URL("../scripts/desktop-server-entry.mjs", import.meta.url));
const DAY_MS = 24 * 60 * 60 * 1000;

test("the packaged server forks the bootstrap with a compile cache under userData", () => {
  const resourcesPath = path.join("/Applications", "Seira.app", "Contents", "Resources");
  const userData = path.join("/Users", "someone", "Library", "Application Support", "Seira");
  assert.deepEqual(serverChildLaunch({ resourcesPath, userData, env: {}, exists: () => true }), {
    entry: path.join(resourcesPath, "server", "desktop-entry.mjs"),
    compileCacheDir: path.join(userData, "server-compile-cache"),
    symlinkEnv: null,
  });
});

test("a server tree without the bootstrap forks index.js with no cache, as before", () => {
  const resourcesPath = path.join("/opt", "Seira", "resources");
  assert.deepEqual(serverChildLaunch({ resourcesPath, userData: "/home/someone/.config/Seira", env: {}, exists: () => false }), {
    entry: path.join(resourcesPath, "server", "index.js"),
    compileCacheDir: null,
    symlinkEnv: null,
  });
});

test("an AppImage forks the server through a fixed link, with the cache and the link name", () => {
  const resourcesPath = "/tmp/.mount_OpenMaXk3f9a/resources";
  const userData = "/home/someone/.config/Seira";
  const links = [];
  const launch = serverChildLaunch({
    resourcesPath, userData,
    env: { APPIMAGE: "/home/someone/Seira.AppImage" },
    exists: () => true,
    link: (from, to) => links.push([from, to]),
  });
  assert.deepEqual(links, [[path.join(userData, "server-resources"), resourcesPath]]);
  assert.deepEqual(launch, {
    entry: path.join(resourcesPath, "server", "desktop-entry.mjs"),
    compileCacheDir: path.join(userData, "server-compile-cache"),
    symlinkEnv: { SEIRA_SERVER_RESOURCES_LINK: path.join(userData, "server-resources") },
  });
});

test("an AppImage whose link cannot be made forks the real bootstrap with no cache and no flags", () => {
  const resourcesPath = "/tmp/.mount_OpenMaXk3f9a/resources";
  assert.deepEqual(serverChildLaunch({
    resourcesPath, userData: "/home/someone/.config/Seira",
    env: { APPIMAGE: "/home/someone/Seira.AppImage" },
    exists: () => true,
    link: () => { throw new Error("EACCES"); },
  }), {
    entry: path.join(resourcesPath, "server", "desktop-entry.mjs"),
    compileCacheDir: null,
    symlinkEnv: null,
  });
});

test("a translocated macOS app forks the real bootstrap with no cache and makes no link", () => {
  const resourcesPath = "/private/var/folders/xy/T/AppTranslocation/2F1C/d/Seira.app/Contents/Resources";
  let linked = false;
  assert.deepEqual(serverChildLaunch({
    resourcesPath, userData: "/Users/someone/Library/Application Support/Seira",
    env: { APPIMAGE: "/x.AppImage" }, exists: () => true, link: () => { linked = true; },
  }), {
    entry: path.join(resourcesPath, "server", "desktop-entry.mjs"),
    compileCacheDir: null,
    symlinkEnv: null,
  });
  assert.equal(linked, false);
});

test("the default link function creates the link and replaces it on the next launch", { skip: process.platform === "win32" }, (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "seira-link-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const userData = path.join(dir, "userData");
  mkdirSync(userData);
  const first = path.join(dir, "mount-one");
  const second = path.join(dir, "mount-two");
  mkdirSync(first); mkdirSync(second);
  const env = { APPIMAGE: "/x.AppImage" };
  serverChildLaunch({ resourcesPath: first, userData, env, exists: () => true });
  const link = path.join(userData, "server-resources");
  assert.equal(readlinkSync(link), first);
  serverChildLaunch({ resourcesPath: second, userData, env, exists: () => true });
  assert.equal(readlinkSync(link), second);
  assert.deepEqual(readdirSync(userData), ["server-resources"]);
});

test("main forks what the helper picks and hands only the server the cache directory", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = main.indexOf("async function startServerOn(port,");
  const body = main.slice(start, main.indexOf("utilityProcess.fork(entry", start));
  assert.match(body, /const \{ entry, compileCacheDir, symlinkEnv \} = serverChildLaunch\(\{\n\s+resourcesPath: process\.resourcesPath,\n\s+userData: app\.getPath\("userData"\),/);
  assert.match(body, /delete childEnv\.SEIRA_SERVER_COMPILE_CACHE;\n\s+if \(compileCacheDir\) childEnv\.SEIRA_SERVER_COMPILE_CACHE = compileCacheDir;\n\s+if \(symlinkEnv\) Object\.assign\(childEnv, symlinkEnv\);/);
  assert.doesNotMatch(body, /execArgv/);
  assert.doesNotMatch(body, /path\.join\(process\.resourcesPath, "server", "index\.js"\)/);
});

test("every server child of one launch gets that launch's id, never one from the shell", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(main, /\nconst desktopLaunchId = randomUUID\(\);\n/);
  const start = main.indexOf("async function startServerOn(port,");
  const body = main.slice(start, main.indexOf("utilityProcess.fork(entry", start));
  const spread = body.indexOf("...process.env,");
  const launch = body.indexOf("SEIRA_DESKTOP_LAUNCH_ID: desktopLaunchId,");
  assert.ok(spread > 0 && launch > spread, "the launch id is set after, so over, the inherited environment");
});

// A staged copy of the bootstrap beside a stand-in index.js that reports what the server would see.
function stage(t, indexSource = REPORTING_INDEX) {
  const dir = mkdtempSync(path.join(tmpdir(), "seira-server-entry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "server"));
  copyFileSync(bootstrapSource, path.join(dir, "server", "desktop-entry.mjs"));
  writeFileSync(path.join(dir, "server", "index.js"), indexSource);
  return dir;
}

// Runs the bootstrap's after-start timer at once instead of in 10 s, and stays alive for it to finish.
const REPORTING_INDEX = `
import module from "node:module";
import { execFileSync } from "node:child_process";
const later = globalThis.setTimeout;
globalThis.setTimeout = (callback, _delay, ...args) => later(callback, 0, ...args);
const child = JSON.parse(execFileSync(process.execPath, ["-e",
  "process.stdout.write(JSON.stringify([process.env.SEIRA_SERVER_COMPILE_CACHE ?? null, process.env.NODE_COMPILE_CACHE ?? null]))"],
  { encoding: "utf8" }));
later(() => console.log(JSON.stringify({
  started: true,
  cacheDir: module.getCompileCacheDir() ?? null,
  env: [process.env.SEIRA_SERVER_COMPILE_CACHE ?? null, process.env.NODE_COMPILE_CACHE ?? null],
  child,
})), 300);
`;

function runEntry(dir, cacheRoot, extraEnv = {}) {
  const env = { ...process.env };
  delete env.NODE_COMPILE_CACHE;
  delete env.NODE_DISABLE_COMPILE_CACHE;
  if (cacheRoot !== undefined) env.SEIRA_SERVER_COMPILE_CACHE = cacheRoot;
  else delete env.SEIRA_SERVER_COMPILE_CACHE;
  Object.assign(env, extraEnv);
  const result = spawnSync(process.execPath, [path.join(dir, "server", "desktop-entry.mjs")], { encoding: "utf8", env, timeout: 20_000 });
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  return { status: result.status, stderr: result.stderr, report: line ? JSON.parse(line) : null };
}

const cacheFiles = (cacheRoot) =>
  readdirSync(cacheRoot)
    .filter((name) => /^v\d+\.\d+\.\d+-/.test(name))
    .flatMap((version) => readdirSync(path.join(cacheRoot, version)).map((file) => path.join(cacheRoot, version, file)));

test("the bootstrap writes the server's compile cache, and the next start runs from it", (t) => {
  const dir = stage(t);
  const cacheRoot = path.join(dir, "cache");
  const first = runEntry(dir, cacheRoot);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.report.started, true);
  assert.equal(path.dirname(first.report.cacheDir), cacheRoot);
  assert.ok(cacheFiles(cacheRoot).length > 0, "the first start must leave cache entries behind");
  const second = runEntry(dir, cacheRoot);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.report.cacheDir, first.report.cacheDir);
});

test("without a cache directory the bootstrap just runs the server", (t) => {
  const dir = stage(t);
  const result = runEntry(dir, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.started, true);
  assert.equal(result.report.cacheDir, null);
});

test("neither the server nor anything it spawns sees a compile-cache variable", (t) => {
  const dir = stage(t);
  const result = runEntry(dir, path.join(dir, "cache"));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.report.env, [null, null]);
  assert.deepEqual(result.report.child, [null, null]);
});

test("an unusable cache never stops the server: a file in its place, or a bad entry", (t) => {
  const dir = stage(t);
  const blocked = path.join(dir, "blocked");
  writeFileSync(blocked, "not a directory");
  const onFile = runEntry(dir, blocked);
  assert.equal(onFile.status, 0, onFile.stderr);
  assert.equal(onFile.report.started, true);
  assert.equal(readFileSync(blocked, "utf8"), "not a directory");

  const cacheRoot = path.join(dir, "cache");
  assert.equal(runEntry(dir, cacheRoot).status, 0);
  const entries = cacheFiles(cacheRoot);
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    const bytes = readFileSync(entry);
    writeFileSync(entry, bytes.map((byte) => byte ^ 0x5a));
  }
  const garbled = runEntry(dir, cacheRoot);
  assert.equal(garbled.status, 0, garbled.stderr);
  assert.equal(garbled.report.started, true);
  for (const entry of cacheFiles(cacheRoot)) writeFileSync(entry, readFileSync(entry).subarray(0, 7));
  const truncated = runEntry(dir, cacheRoot);
  assert.equal(truncated.status, 0, truncated.stderr);
  assert.equal(truncated.report.started, true);
});

test("a cache under a read-only folder never stops the server", { skip: process.platform === "win32" || process.getuid?.() === 0 }, (t) => {
  const dir = stage(t);
  const readOnly = path.join(dir, "read-only");
  mkdirSync(readOnly);
  chmodSync(readOnly, 0o555);
  let result;
  try {
    result = runEntry(dir, path.join(readOnly, "cache"));
  } finally {
    chmodSync(readOnly, 0o755);
  }
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.started, true);
});

test("a server that fails to load still exits non-zero through the bootstrap", (t) => {
  const dir = stage(t, 'throw new Error("server failed to load");\n');
  const result = runEntry(dir, path.join(dir, "cache"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /server failed to load/);
});

test("pruning removes only other Node versions' cache folders that went unused for a day", (t) => {
  const dir = stage(t);
  const cacheRoot = path.join(dir, "cache");
  mkdirSync(cacheRoot);
  const old = new Date(Date.now() - 3 * DAY_MS);
  const folder = (name, mtime) => {
    mkdirSync(path.join(cacheRoot, name));
    writeFileSync(path.join(cacheRoot, name, "deadbeef"), "entry");
    if (mtime) utimesSync(path.join(cacheRoot, name), mtime, mtime);
  };
  folder("v20.1.0-x64-0123abcd-501", old);
  folder("v22.0.0-arm64-89abcdef-501");
  folder("notes", old);
  writeFileSync(path.join(cacheRoot, "v18.0.0-file"), "not a folder");
  utimesSync(path.join(cacheRoot, "v18.0.0-file"), old, old);
  writeFileSync(path.join(cacheRoot, "README"), "kept");

  const result = runEntry(dir, cacheRoot);
  assert.equal(result.status, 0, result.stderr);
  const left = readdirSync(cacheRoot).sort();
  assert.ok(!left.includes("v20.1.0-x64-0123abcd-501"), "an unused older Node's cache is removed");
  assert.ok(left.includes("v22.0.0-arm64-89abcdef-501"), "a cache another Node used today stays");
  for (const kept of ["notes", "v18.0.0-file", "README", path.basename(result.report.cacheDir)]) {
    assert.ok(left.includes(kept), `${kept} must survive pruning`);
  }
});

test("a warm start marks its own cache folder as used, so another install never prunes it", (t) => {
  const dir = stage(t);
  const cacheRoot = path.join(dir, "cache");
  const first = runEntry(dir, cacheRoot);
  assert.equal(first.status, 0, first.stderr);
  const old = new Date(Date.now() - 3 * DAY_MS);
  utimesSync(first.report.cacheDir, old, old);
  assert.equal(runEntry(dir, cacheRoot).status, 0);
  assert.ok(Date.now() - statSync(first.report.cacheDir).mtimeMs < DAY_MS);
});

test("nothing is pruned when Node keeps its cache somewhere else", (t) => {
  const dir = stage(t);
  const cacheRoot = path.join(dir, "cache");
  mkdirSync(cacheRoot);
  const stale = path.join(cacheRoot, "v20.1.0-x64-0123abcd-501");
  mkdirSync(stale);
  const old = new Date(Date.now() - 3 * DAY_MS);
  utimesSync(stale, old, old);
  // NODE_COMPILE_CACHE from the launching environment wins: Node reports ALREADY_ENABLED.
  const result = runEntry(dir, cacheRoot, { NODE_COMPILE_CACHE: path.join(dir, "elsewhere") });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(stale));
});

const hooksSupported = process.platform !== "win32" && typeof module.registerHooks === "function";

const LINKED_INDEX = `
import { createRequire } from "node:module";
import { url as bUrl, cjs } from "./lib/b.mjs";
const require = createRequire(import.meta.url);
console.log(JSON.stringify({
  index: import.meta.url,
  b: bUrl,
  c: cjs,
  c2: require("./lib/c.cjs"),
  link: process.env.SEIRA_SERVER_RESOURCES_LINK ?? null,
}));
`;
const B_SOURCE = `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
function describe(value) {
  const parts = [];
  for (let i = 0; i < 20; i += 1) parts.push(String(value) + ":" + i);
  return parts.join("|");
}
export const cjs = require("./c.cjs");
export const url = import.meta.url;
export const summary = describe(url);
`;
const C_SOURCE = `
function twice(value) {
  const out = [];
  for (let i = 0; i < 20; i += 1) out.push(value + i);
  return out.length;
}
twice(__filename);
module.exports = __filename;
`;

function stageResources(t, name) {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "seira-resources-")), name);
  t.after(() => rmSync(path.dirname(root), { recursive: true, force: true }));
  mkdirSync(path.join(root, "server", "lib"), { recursive: true });
  copyFileSync(bootstrapSource, path.join(root, "server", "desktop-entry.mjs"));
  writeFileSync(path.join(root, "server", "index.js"), LINKED_INDEX);
  writeFileSync(path.join(root, "server", "lib", "b.mjs"), B_SOURCE);
  writeFileSync(path.join(root, "server", "lib", "c.cjs"), C_SOURCE);
  return root;
}

function runLinked(entry, env) {
  const full = { ...process.env, ...env };
  delete full.NODE_COMPILE_CACHE;
  delete full.NODE_DISABLE_COMPILE_CACHE;
  const result = spawnSync(process.execPath, [entry], { encoding: "utf8", env: full, timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr);
  return { stderr: result.stderr, report: JSON.parse(result.stdout.trim().split("\n").filter(Boolean).at(-1)) };
}

const countFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).reduce(
    (sum, entry) => sum + (entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1), 0);

const underLink = (report, link) => [report.index, report.b, report.c, report.c2].every((value) =>
  value.startsWith(`file://${link}/`) || value.startsWith(`${link}/`));

test("the server loads its modules through the fixed link and reuses the cache after the mount moves", { skip: !hooksSupported }, (t) => {
  const a = stageResources(t, "mount-a");
  const b = stageResources(t, "mount-b");
  const link = path.join(path.dirname(a), "server-resources");
  const cache = path.join(path.dirname(a), "cache");
  const env = { SEIRA_SERVER_COMPILE_CACHE: cache, SEIRA_SERVER_RESOURCES_LINK: link };
  symlinkSync(a, link, "dir");
  const first = runLinked(path.join(a, "server", "desktop-entry.mjs"), env);
  assert.ok(underLink(first.report, link), JSON.stringify(first.report));
  assert.equal(first.report.link, null);
  const written = countFiles(cache);
  assert.ok(written > 0, "the first start must leave cache entries behind");

  rmSync(link);
  symlinkSync(b, link, "dir");
  const second = runLinked(path.join(b, "server", "desktop-entry.mjs"), env);
  assert.ok(underLink(second.report, link), JSON.stringify(second.report));
  assert.equal(countFiles(cache), written, "a moved mount must reuse the cache entries, not add new ones");
  t.diagnostic(`ExperimentalWarning in stderr: ${/ExperimentalWarning/.test(first.stderr + second.stderr)}`);
});

test("a missing link leaves the server on its real path", { skip: !hooksSupported }, (t) => {
  const real = stageResources(t, "mount-a");
  const missing = path.join(path.dirname(real), "no-such-link");
  const { report } = runLinked(path.join(real, "server", "desktop-entry.mjs"), { SEIRA_SERVER_RESOURCES_LINK: missing });
  assert.ok(underLink(report, realpathSync(real)), JSON.stringify(report));
  assert.equal(report.link, null);
});

test("a link to another app leaves the server on its real path", { skip: !hooksSupported }, (t) => {
  const real = stageResources(t, "mount-a");
  const other = stageResources(t, "mount-b");
  const link = path.join(path.dirname(real), "server-resources");
  symlinkSync(other, link, "dir");
  const { report } = runLinked(path.join(real, "server", "desktop-entry.mjs"), { SEIRA_SERVER_RESOURCES_LINK: link });
  assert.ok(underLink(report, realpathSync(real)), JSON.stringify(report));
});
