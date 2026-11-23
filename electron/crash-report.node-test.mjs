import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCrashReports } from "./crash-report.mjs";
import { createDesktopPrefs } from "./desktop-prefs.mjs";

const CONFIG = { url: "http://127.0.0.1:4010/in", environment: "test" };
const MINUTE = 60_000;
const ROOTS = ["/opt/Seira/resources/app.asar", "/opt/Seira/resources"];
const SERVER_STACK = "TypeError: boom\n    at run (/opt/Seira/resources/server/index.js:10:5)\n    at main (/opt/Seira/resources/server/index.js:20:5)";

function ipcFake() {
  const on = new Map(), handle = new Map();
  return { on: (channel, fn) => on.set(channel, fn), handle: (channel, fn) => handle.set(channel, fn),
    send: (channel, event, ...args) => on.get(channel)?.(event, ...args), ask: (channel, event, ...args) => handle.get(channel)(event, ...args),
    read: (event) => { const reply = { returnValue: undefined, ...event }; on.get("desktop-crash-reports:read")(reply); return reply.returnValue; } };
}

/** A desktop whose clock, timers, network, disk and Electron are fakes; `restart()` is the next app start on the same disk. */
function world(t, options = {}) {
  const root = options.root ?? fs.mkdtempSync(join(tmpdir(), "crash-report-"));
  if (!options.root) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = options.clock ?? { now: Date.now() };
  const state = { on: options.on ?? true, readable: options.readable ?? true, shuttingDown: false, local: true };
  const requests = [], logLines = [], timers = [], answers = [...(options.answers ?? [])];
  const savedPrefs = options.savedPrefs ?? { crashReports: undefined };
  const prefs = createDesktopPrefs({
    read: () => { if (!state.readable) throw new SyntaxError("Unexpected token"); if (savedPrefs.exists === false) throw Object.assign(new Error("none"), { code: "ENOENT" }); return savedPrefs.crashReports === undefined ? {} : { crashReports: savedPrefs.crashReports }; },
    write: (value) => { savedPrefs.crashReports = value.crashReports; savedPrefs.exists = true; },
  });
  if (options.on !== undefined && state.readable) prefs.setCrashReports(options.on);
  const app = Object.assign(new EventEmitter(), { isPackaged: options.packaged ?? true, getVersion: () => "1.2.3", getPath: (name) => (name === "crashDumps" ? join(root, "dumps") : root) });
  const processTarget = Object.assign(new EventEmitter(), { versions: { electron: "43.0.0" }, getSystemVersion: () => "14.2.1" });
  const ipcMain = ipcFake();
  const crashReporter = { starts: [], start(config) { this.starts.push(config); } };
  const reporting = {
    fetch: async (url, init) => {
      requests.push({ url, init, body: String(init.body) });
      const next = answers.length ? answers.shift() : { status: 200 };
      if (next instanceof Error) throw next;
      return { status: next.status, headers: { get: (name) => next.headers?.[name.toLowerCase()] ?? null }, body: null };
    },
    schedule: (fn, ms) => { const timer = { fn, ms, live: true }; timers.push(timer); return timer; },
    cancel: (timer) => { timer.live = false; },
  };
  const create = () => createCrashReports({
    app, ipcMain, crashReporter, prefs, userData: root, config: "config" in options ? options.config : CONFIG, roots: ROOTS, now: () => clock.now,
    os: { userInfo: () => ({ username: "canaryuser" }), hostname: () => "canary-host", release: () => "6.8.0" },
    appendCrashLog: (line) => logLines.push(line), isShuttingDown: () => state.shuttingDown, mainWebContents: () => null, isLocalSender: () => state.local,
    processTarget, platform: "linux", env: {}, packageMarker: "deb", ...reporting, ...options.extra,
  });
  const reports = create();
  const queueDir = join(root, "crash-reports");
  const waiting = () => (fs.existsSync(queueDir) ? fs.readdirSync(queueDir).filter((name) => /^\d{14}-/.test(name)) : []);
  const bodies = () => requests.map((request) => request.body.split("\n"));
  const events = () => bodies().map((lines) => JSON.parse(lines[2]));
  const throwUncaught = (error = new TypeError("x is not a function")) => processTarget.emit("uncaughtExceptionMonitor", error, "uncaughtException");
  return { root, clock, state, requests, logLines, timers, answers, prefs, savedPrefs, app, processTarget, ipcMain, crashReporter, reports, queueDir, waiting, bodies, events,
    throwUncaught, restart: () => world(t, { ...options, root, clock, savedPrefs, extra: options.extra, answers: [] }), dumps: join(root, "dumps"),
    liveTimers: () => timers.filter((timer) => timer.live) };
}

const sleepSettled = () => new Promise((resolve) => setImmediate(resolve));
async function settle(w) { await w.reports.flush(); await sleepSettled(); await w.reports.flush(); }

test("AC-04: a computer with no saved choice reports; AC-05: a saved record that cannot be read does not", (t) => {
  const fresh = world(t, { savedPrefs: { exists: false } });
  assert.equal(fresh.reports.switchOn(), true);
  assert.equal(fresh.ipcMain.read({}), true);
  const empty = world(t, { savedPrefs: {} });
  assert.equal(empty.reports.switchOn(), true, "a record with no crashReports key means on");
  const broken = world(t, { readable: false });
  assert.equal(broken.reports.switchOn(), false);
  assert.equal(broken.ipcMain.read({}), false);
  broken.throwUncaught();
  assert.deepEqual(broken.waiting(), []);
  assert.deepEqual(broken.crashReporter.starts, []);
  const saved = world(t, { savedPrefs: { exists: true, crashReports: false } });
  assert.equal(saved.reports.switchOn(), false, "a saved off stays off after an update");
});

test("AC-06: while the switch is off nothing is queued and no request is made, whatever crashes", async (t) => {
  const w = world(t, { on: false });
  const contents = new EventEmitter();
  w.throwUncaught();
  w.app.emit("render-process-gone", {}, contents, { reason: "crashed", exitCode: 9 });
  w.app.emit("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: 9 });
  w.reports.hang(contents);
  w.ipcMain.send("desktop-crash-reports:renderer", {}, { kind: "renderer-error", errorName: "Error", message: "x", stack: "" });
  const acks = [];
  w.reports.receive({ postMessage: (m) => acks.push(m) }, { type: "seira:crash-report", requestId: "abcdefgh1", report: { kind: "server-turn", errorName: "Error", message: "x", stack: "" } });
  w.reports.serverExit({}, 1);
  w.timers.forEach((timer) => timer.live && timer.fn());
  await settle(w);
  assert.deepEqual(w.waiting(), []);
  assert.equal(w.requests.length, 0);
  assert.deepEqual(acks, [{ type: "seira:crash-report-ack", requestId: "abcdefgh1" }], "the server is still answered");
  assert.deepEqual(w.crashReporter.starts, [], "no native reporter runs while the switch is off");
});

test("AC-07: a crash that happened while the switch was off is never sent, not after turning it on and restarting", async (t) => {
  const w = world(t, { on: false });
  w.throwUncaught();
  await w.ipcMain.ask("desktop-crash-reports:set", {}, true);
  const next = w.restart();
  next.timers.forEach((timer) => timer.live && timer.fn());
  await settle(next);
  assert.equal(next.requests.length, 0);
  assert.deepEqual(next.waiting(), []);
});

test("AC-08: turning the switch off deletes every waiting report at once and keeps it off after a restart", async (t) => {
  const w = world(t, { answers: [{ status: 503 }, { status: 503 }, { status: 503 }] });
  w.throwUncaught();
  w.throwUncaught(new RangeError("other"));
  await settle(w);
  assert.equal(w.waiting().length >= 1, true);
  await w.ipcMain.ask("desktop-crash-reports:set", {}, false);
  assert.deepEqual(w.waiting(), []);
  assert.equal(w.reports.switchOn(), false);
  const next = w.restart();
  assert.equal(next.reports.switchOn(), false);
  assert.equal(JSON.parse(fs.readFileSync(join(w.queueDir, "session.json"), "utf8")).on, false);
});

test("AC-09: the switch is read for every report, so a change needs no restart of the server", (t) => {
  const w = world(t, {});
  const message = (id, name) => ({ type: "seira:crash-report", requestId: id, report: { kind: "server-turn", errorName: "TypeError", message: "x", stack: `TypeError\n    at ${name} (/opt/Seira/resources/server/a.js:1:1)` } });
  const proc = { postMessage() {} };
  w.reports.receive(proc, message("request-1", "first"));
  assert.equal(w.waiting().length, 1);
  w.ipcMain.ask("desktop-crash-reports:set", {}, false);
  w.reports.receive(proc, message("request-2", "second"));
  assert.equal(w.waiting().length, 0, "off: dropped");
  w.ipcMain.ask("desktop-crash-reports:set", {}, true);
  w.reports.receive(proc, message("request-3", "second"));
  assert.equal(w.waiting().length, 1, "the error that was dropped while off reports once it is back on");
  w.reports.receive(proc, message("request-4", "second"));
  assert.equal(w.waiting().length, 1, "and the same error is then reported once");
});

test("AC-10: turning the switch on reports the crashes after that moment and starts the native reporter", async (t) => {
  const w = world(t, { on: false });
  assert.deepEqual(w.crashReporter.starts, []);
  await w.ipcMain.ask("desktop-crash-reports:set", {}, true);
  assert.deepEqual(w.crashReporter.starts, [{ uploadToServer: false, compress: false }]);
  await w.ipcMain.ask("desktop-crash-reports:set", {}, false);
  await w.ipcMain.ask("desktop-crash-reports:set", {}, true);
  assert.equal(w.crashReporter.starts.length, 1, "Crashpad starts once");
  w.throwUncaught();
  await settle(w);
  assert.equal(w.requests.length, 1);
});

test("the switch can be read and set only by this computer's own page", async (t) => {
  const w = world(t, {});
  w.state.local = false;
  assert.equal(w.ipcMain.read({}), null);
  await assert.rejects(async () => w.ipcMain.ask("desktop-crash-reports:set", {}, false), /only available/);
  assert.equal(w.reports.switchOn(), true);
  w.ipcMain.send("desktop-crash-reports:renderer", {}, { kind: "renderer-error", errorName: "Error", message: "x", stack: "" });
  assert.deepEqual(w.waiting(), []);
});

test("AC-11: an uncaught exception in main is one report, written to disk before anything async", async (t) => {
  const w = world(t, {});
  const error = new TypeError("x is not a function");
  error.stack = "TypeError: x is not a function\n    at start (/opt/Seira/resources/app.asar/electron/main.mjs:5:5)\n    at /home/canaryuser/leak.js:1:1";
  w.throwUncaught(error);
  assert.equal(w.waiting().length, 1, "queued synchronously");
  await settle(w);
  const [event] = w.events();
  assert.equal(event.exception.values[0].type, "TypeError");
  assert.equal(event.exception.values[0].value, "x is not a function");
  assert.deepEqual(event.exception.values[0].stacktrace.frames.map((frame) => frame.filename), ["<external>", "app:///electron/main.mjs"]);
  assert.equal(event.tags.kind, "main-error");
  assert.equal(event.tags.process, "main");
  assert.equal(event.level, "fatal");
  assert.equal(w.requests.length, 1);
  assert.equal(w.requests[0].url, CONFIG.url);
  assert.equal(w.requests[0].init.method, "POST");
  assert.equal(w.requests[0].init.headers["content-type"], "application/x-sentry-envelope");
  assert.ok(w.requests[0].init.signal, "a timeout is set");
});

test("AC-11: a message with a path stays out, and a thrown value that is not an Error is still a report", async (t) => {
  const w = world(t, {});
  w.throwUncaught(new Error("cannot open /home/canaryuser/notes.txt"));
  w.throwUncaught("a string");
  w.throwUncaught(null);
  await settle(w);
  assert.equal(w.requests.length >= 1, true);
  for (const event of w.events()) assert.equal("value" in event.exception.values[0], false);
});

test("AC-12: a main process that ended with a native crash is one report at the next start", async (t) => {
  const first = world(t, {});
  assert.deepEqual(first.crashReporter.starts, [{ uploadToServer: false, compress: false }]);
  const marker = JSON.parse(fs.readFileSync(join(first.queueDir, "session.json"), "utf8"));
  assert.deepEqual([marker.clean, marker.on, marker.childCrashes], [false, true, 0]);
  fs.mkdirSync(join(first.dumps, "completed"), { recursive: true });
  const dump = join(first.dumps, "completed", "a.dmp");
  fs.writeFileSync(dump, "CANARY-MEMORY");
  // Linux stamps a file with a coarse clock that can lag Date.now by a tick, so the test sets the crash time itself.
  const crashedAt = new Date(first.clock.now + 1_000);
  fs.utimesSync(dump, crashedAt, crashedAt);
  first.clock.now += 5_000;
  const next = first.restart();
  assert.equal(fs.existsSync(dump), false, "every dump is deleted");
  assert.equal(next.waiting().length, 1);
  await settle(next);
  assert.equal(next.requests.length, 1);
  const [event] = next.events();
  assert.deepEqual([event.tags.kind, event.tags.process, event.tags.reason], ["native", "main", "crashed"]);
  assert.doesNotMatch(next.requests[0].body, /CANARY-MEMORY|attachment|minidump/);
  assert.ok(next.timers.some((timer) => timer.ms <= 60_000 && timer.ms > 0), "the first send is due within 60 seconds");
});

test("AC-12: no main report after a clean quit, an old dump, a switch that was off, or crashes of child processes only", async (t) => {
  const dumpAt = (w, mtimeOffsetMs = 0) => {
    fs.mkdirSync(join(w.dumps, "completed"), { recursive: true });
    const file = join(w.dumps, "completed", `${Math.random()}.dmp`);
    fs.writeFileSync(file, "x");
    const when = new Date(w.clock.now + mtimeOffsetMs);
    fs.utimesSync(file, when, when);
    return file;
  };
  const clean = world(t, {});
  dumpAt(clean, 1000);
  clean.app.emit("will-quit");
  assert.equal(JSON.parse(fs.readFileSync(join(clean.queueDir, "session.json"), "utf8")).clean, true);
  assert.equal(clean.restart().waiting().length, 0);

  const old = world(t, {});
  const oldDump = dumpAt(old, -60_000);
  assert.equal(old.restart().waiting().length, 0);
  assert.equal(fs.existsSync(oldDump), false, "an old dump is deleted too");

  const off = world(t, { on: false });
  dumpAt(off, 1000);
  assert.equal(off.restart().waiting().length, 0);

  const child = world(t, {});
  child.app.emit("render-process-gone", {}, new EventEmitter(), { reason: "crashed", exitCode: 9 });
  child.app.emit("child-process-gone", {}, { type: "GPU", reason: "oom", exitCode: 9 });
  dumpAt(child, 1000);
  dumpAt(child, 1000);
  assert.equal(JSON.parse(fs.readFileSync(join(child.queueDir, "session.json"), "utf8")).childCrashes, 2);
  await settle(child);
  assert.equal(child.restart().waiting().length, 0, "two dumps, two child crashes: the main process did not crash");

  const more = world(t, {});
  more.app.emit("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: 9 });
  dumpAt(more, 1000);
  dumpAt(more, 1000);
  await settle(more);
  assert.equal(more.restart().waiting().length, 1, "one dump more than the child crashes seen");
});

test("AC-12: a build without an endpoint never touches the dump folder", (t) => {
  const w = world(t, { config: null });
  fs.mkdirSync(w.dumps, { recursive: true });
  fs.writeFileSync(join(w.dumps, "a.dmp"), "x");
  w.restart();
  assert.equal(fs.existsSync(join(w.dumps, "a.dmp")), true);
});

test("AC-13: a renderer, GPU or utility process that ended with a crash is one report with its type, reason and exit code", async (t) => {
  const w = world(t, {});
  w.app.emit("render-process-gone", {}, new EventEmitter(), { reason: "crashed", exitCode: 11 });
  w.app.emit("child-process-gone", {}, { type: "GPU", reason: "abnormal-exit", exitCode: 12 });
  w.app.emit("child-process-gone", {}, { type: "Utility", reason: "killed", exitCode: 13 });
  await settle(w);
  const tags = w.events().map((event) => [event.tags.process, event.tags.reason, event.tags.exit_code, event.tags.kind]);
  assert.deepEqual(tags.sort(), [["gpu", "abnormal-exit", "12", "native"], ["renderer", "crashed", "11", "native"], ["utility", "killed", "13", "native"]]);
});

test("AC-13: a clean exit, a shutdown, an unknown child and a repeat are not reported", async (t) => {
  const w = world(t, {});
  w.app.emit("render-process-gone", {}, new EventEmitter(), { reason: "clean-exit", exitCode: 0 });
  w.app.emit("child-process-gone", {}, { type: "Pepper Plugin", reason: "crashed", exitCode: 1 });
  w.app.emit("child-process-gone", {}, { type: "GPU", reason: "clean-exit", exitCode: 0 });
  w.state.shuttingDown = true;
  w.app.emit("render-process-gone", {}, new EventEmitter(), { reason: "crashed", exitCode: 1 });
  w.state.shuttingDown = false;
  await settle(w);
  assert.equal(w.requests.length, 0);
  w.app.emit("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: 1 });
  w.app.emit("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: 1 });
  await settle(w);
  assert.equal(w.requests.length, 1, "AC-47: one report for one signature in one app start");
});

test("AC-14: the page's error is one non-fatal report, and only this page's error", async (t) => {
  const w = world(t, {});
  const stack = "Error: x\n    at f (http://127.0.0.1:8799/assets/index-1.js:1:2)";
  w.ipcMain.send("desktop-crash-reports:renderer", {}, { kind: "renderer-rejection", errorName: "TypeError", message: "x is bad", stack, page: "chat", debugIds: { "http://127.0.0.1:8799/assets/index-1.js": "0123abcd-0123-4abc-8def-0123456789ab" } });
  w.ipcMain.send("desktop-crash-reports:renderer", {}, { kind: "server-exit", errorName: "Error", message: "x", stack: "" });
  w.ipcMain.send("desktop-crash-reports:renderer", {}, null);
  w.ipcMain.send("desktop-crash-reports:renderer", {}, "text");
  await settle(w);
  assert.equal(w.requests.length, 1);
  const [event] = w.events();
  assert.deepEqual([event.tags.kind, event.tags.process, event.tags.page, event.level], ["renderer-rejection", "renderer", "chat", "error"]);
  assert.equal(event.exception.values[0].stacktrace.frames[0].filename, "app:///ui/assets/index-1.js");
  assert.equal(event.debug_meta.images[0].code_file, "app:///ui/assets/index-1.js");
});

test("AC-15: a forced end of a hung page is one hang report with the page name and no native report", async (t) => {
  const w = world(t, {});
  const contents = new EventEmitter();
  w.ipcMain.send("desktop-crash-reports:page", { sender: contents }, "settings");
  w.reports.hang(contents);
  w.app.emit("render-process-gone", {}, contents, { reason: "crashed", exitCode: 9 });
  await settle(w);
  assert.equal(w.requests.length, 1);
  const [event] = w.events();
  assert.deepEqual([event.tags.kind, event.tags.page, event.tags.process], ["hang", "settings", "renderer"]);
  assert.equal(JSON.parse(fs.readFileSync(join(w.queueDir, "session.json"), "utf8")).childCrashes, 1, "the forced crash still leaves a dump, so it counts");
  w.app.emit("render-process-gone", {}, contents, { reason: "crashed", exitCode: 9 });
  await settle(w);
  assert.equal(w.events().at(-1).tags.kind, "native", "a later crash of the same page is a crash");
});

test("AC-15: the hang mark does not hide a crash of another page or one long after", async (t) => {
  const w = world(t, {});
  const [one, two] = [new EventEmitter(), new EventEmitter()];
  w.reports.hang(one);
  w.app.emit("render-process-gone", {}, two, { reason: "crashed", exitCode: 9 });
  await settle(w);
  assert.deepEqual(w.events().map((event) => event.tags.kind).sort(), ["hang", "native"]);
  const late = world(t, {});
  const page = new EventEmitter();
  late.reports.hang(page);
  late.clock.now += 11_000;
  late.app.emit("render-process-gone", {}, page, { reason: "oom", exitCode: 9 });
  await settle(late);
  assert.deepEqual(late.events().map((event) => event.tags.kind).sort(), ["hang", "native"]);
});

test("AC-17: a server report is queued and acknowledged by its request id, also when it is dropped", async (t) => {
  const w = world(t, {});
  const acks = [];
  const proc = { postMessage: (message) => acks.push(message) };
  const request = (requestId, report) => ({ type: "seira:crash-report", requestId, report });
  assert.equal(w.reports.receive(proc, { type: "seira:other" }), false);
  assert.equal(w.reports.receive(proc, null), false);
  assert.equal(w.reports.receive(proc, request("req-12345", { kind: "server-exit", errorName: "TypeError", errorCode: "ERR_X", message: "boom", stack: SERVER_STACK })), true);
  assert.equal(w.waiting().length, 1, "the report is on disk when the ack goes out");
  assert.deepEqual(acks, [{ type: "seira:crash-report-ack", requestId: "req-12345" }]);
  assert.equal(w.reports.receive(proc, request("req-67890", { kind: "not-a-kind", errorName: "Error" })), true);
  assert.equal(w.reports.receive(proc, request("bad id!", { kind: "server-exit" })), true);
  assert.equal(w.reports.receive(proc, request("short", { kind: "server-exit" })), true);
  assert.deepEqual(acks.map((ack) => ack.requestId), ["req-12345", "req-67890"], "a request id that is not valid gets no answer");
  assert.equal(w.reports.receive({ postMessage() { throw new Error("gone"); } }, request("req-99999", { kind: "server-turn", errorName: "Error", stack: "" })), true);
  await settle(w);
  const event = w.events()[0];
  assert.deepEqual([event.tags.kind, event.tags.process, event.tags.error_code, event.level], ["server-exit", "server", "ERR_X", "fatal"]);
  assert.equal(event.exception.values[0].stacktrace.frames[0].filename, "app:///server/index.js");
});

test("AC-18: a server turn failure is non-fatal and its engine tag is a short word or custom", async (t) => {
  const w = world(t, {});
  const proc = { postMessage() {} };
  const turn = (id, engine) => ({ type: "seira:crash-report", requestId: id, report: { kind: "server-turn", errorName: "Error", engine, stack: `Error\n    at ${engine.replace(/\W/g, "")} (/opt/Seira/resources/server/a.js:1:1)` } });
  w.reports.receive(proc, turn("request-aa", "claude"));
  w.reports.receive(proc, turn("request-bb", "My Private Bot Name"));
  await settle(w);
  assert.deepEqual(w.events().map((event) => [event.tags.engine, event.level]).sort(), [["claude", "error"], ["custom", "error"]]);
});

test("AC-20: a server that ends by itself with an odd exit code is one report with that code", async (t) => {
  const w = world(t, {});
  const proc = {};
  w.reports.serverExit(proc, 3);
  assert.equal(w.waiting().length, 0, "main waits to see whether a native crash report covers it");
  const wait = w.liveTimers().find((timer) => timer.ms === 3_000);
  assert.ok(wait);
  wait.fn();
  await settle(w);
  const [event] = w.events();
  assert.deepEqual([event.tags.kind, event.tags.process, event.tags.exit_code], ["server-exit", "server", "3"]);
});

test("AC-20: no report for exit codes 0, 70 and 75, for a stop main asked for, or during shutdown", async (t) => {
  const w = world(t, {});
  for (const code of [0, 70, 75]) w.reports.serverExit({}, code);
  const stopped = {};
  w.reports.stopping(stopped);
  w.reports.stopping(null);
  w.reports.serverExit(stopped, 143);
  w.state.shuttingDown = true;
  w.reports.serverExit({}, 5);
  w.state.shuttingDown = false;
  assert.equal(w.liveTimers().filter((timer) => timer.ms === 3_000).length, 0);
  const late = {};
  w.reports.serverExit(late, 9);
  w.state.shuttingDown = true;
  w.liveTimers().find((timer) => timer.ms === 3_000).fn();
  await settle(w);
  assert.equal(w.requests.length, 0, "an app that began to quit before the wait ended reports nothing");
});

test("AC-20: no second report when a utility process native crash report covers the exit, before or after it", async (t) => {
  const after = world(t, {});
  after.reports.serverExit({}, 1);
  after.clock.now += 1_000;
  after.app.emit("child-process-gone", {}, { type: "Utility", reason: "crashed", exitCode: 1 });
  after.clock.now += 2_000;
  after.liveTimers().find((timer) => timer.ms === 3_000).fn();
  await settle(after);
  assert.deepEqual(after.events().map((event) => event.tags.kind), ["native"]);

  const before = world(t, {});
  before.app.emit("child-process-gone", {}, { type: "Utility", reason: "crashed", exitCode: 1 });
  before.clock.now += 2_000;
  before.reports.serverExit({}, 1);
  before.clock.now += 3_000;
  before.liveTimers().find((timer) => timer.ms === 3_000).fn();
  await settle(before);
  assert.deepEqual(before.events().map((event) => event.tags.kind), ["native"]);

  const far = world(t, {});
  far.app.emit("child-process-gone", {}, { type: "Utility", reason: "crashed", exitCode: 1 });
  far.clock.now += 10_000;
  far.reports.serverExit({}, 1);
  far.clock.now += 3_000;
  far.liveTimers().find((timer) => timer.ms === 3_000).fn();
  await settle(far);
  assert.deepEqual(far.events().map((event) => event.tags.kind).sort(), ["native", "server-exit"]);
});

test("AC-22: a report stays on disk when the endpoint is down or answers 5xx, and goes out later", async (t) => {
  const w = world(t, { answers: [new Error("offline"), { status: 503 }, { status: 502 }] });
  w.throwUncaught();
  await sleepSettled();
  assert.equal(w.requests.length, 1);
  assert.equal(w.waiting().length, 1);
  await w.reports.flush();
  assert.equal(w.waiting().length, 1);
  const retry = w.liveTimers().find((timer) => timer.ms === 5 * MINUTE);
  assert.ok(retry, "a retry is due in 5 minutes");
  await w.reports.flush();
  assert.equal(w.waiting().length, 1);
  await w.reports.flush();
  assert.equal(w.waiting().length, 0, "the next answer is 200");
  assert.equal(w.requests.length, 4);
  assert.equal(new Set(w.requests.map((request) => request.body)).size, 1, "the same report each time");
});

test("AC-22: the first send is about 10 seconds after start and a retry timer runs every 5 minutes", (t) => {
  const w = world(t, {});
  assert.deepEqual(w.timers.map((timer) => timer.ms).sort((a, b) => a - b), [10_000, 5 * MINUTE]);
  const repeat = w.timers.find((timer) => timer.ms === 5 * MINUTE);
  repeat.fn();
  assert.equal(w.timers.filter((timer) => timer.ms === 5 * MINUTE).length, 2, "it re-arms itself");
});

test("AC-22: a report waiting from an earlier run is sent after the restart", async (t) => {
  const w = world(t, { answers: [{ status: 503 }] });
  w.throwUncaught();
  await sleepSettled();
  assert.equal(w.waiting().length, 1);
  const next = w.restart();
  next.timers.find((timer) => timer.ms === 10_000).fn();
  await settle(next);
  assert.equal(next.requests.length, 1);
  assert.equal(next.waiting().length, 0);
});

test("AC-25: a sent report adds one line with its id and kind and no message text", async (t) => {
  const w = world(t, {});
  w.throwUncaught(new Error("plain words"));
  await settle(w);
  assert.equal(w.logLines.length >= 1, true);
  const line = w.logLines.find((entry) => entry.startsWith("event=crash-report"));
  const id = w.events()[0].event_id;
  assert.equal(line, `event=crash-report id=${id} kind=main-error`);
  assert.doesNotMatch(line, /plain words/);
});

test("AC-26: the ids of reports sent in the last 7 days are available and older ones are not", async (t) => {
  const w = world(t, {});
  w.throwUncaught();
  await settle(w);
  const [id] = w.reports.crashReportIds();
  assert.equal(id, w.events()[0].event_id);
  assert.deepEqual(w.reports.crashReportIds(7), [id]);
  w.clock.now += 8 * 24 * 60 * MINUTE;
  assert.deepEqual(w.reports.crashReportIds(), []);
  assert.deepEqual(w.reports.crashReportIds(30), [id]);
});

test("AC-27: a report carries the app version, package type, platform and OS version", async (t) => {
  const w = world(t, {});
  w.throwUncaught();
  await settle(w);
  const [event] = w.events();
  assert.equal(event.release, "seira@1.2.3");
  assert.equal(event.tags.package, "deb");
  assert.deepEqual(event.contexts.os, { name: "Linux", version: "14.2.1" });
  assert.equal(event.environment, "test");
});

test("the OS version falls back to the kernel release, and a build that is not packaged says dev", async (t) => {
  const w = world(t, { packaged: false, extra: { processTarget: Object.assign(new EventEmitter(), { versions: { electron: "43.0.0" } }) } });
  w.reports.receive({ postMessage() {} }, { type: "seira:crash-report", requestId: "request-os", report: { kind: "server-turn", errorName: "Error", stack: "" } });
  await settle(w);
  const [event] = w.events();
  assert.equal(event.contexts.os.version, "6.8.0");
  assert.equal(event.tags.package, "dev");
});

test("AC-41: a canary in the message, stack, function name, host name, user name and breadcrumbs is not in the request body", async (t) => {
  const w = world(t, {});
  const stack = ["Error: canary", "    at canary/fn (/home/canaryuser/canary-dir/canary.js:1:1)", "    at CANARY@x (/opt/Seira/resources/app.asar/electron/main.mjs:1:1)"].join("\n");
  const error = Object.assign(new Error("canary at /home/canaryuser/x canary-host canary@example.test"), { stack, name: "CanaryError", code: "canary" });
  w.throwUncaught(error);
  w.ipcMain.send("desktop-crash-reports:renderer", {}, { kind: "renderer-error", errorName: "CanaryError", message: "bad 'canary'", stack, page: "/canary/page" });
  w.ipcMain.send("desktop-crash-reports:page", { sender: new EventEmitter() }, "/canary/page");
  w.reports.receive({ postMessage() {} }, { type: "seira:crash-report", requestId: "request-canary", report: { kind: "server-turn", errorName: "CanaryError", errorCode: "canary", engine: "canary bot", message: "user canaryuser", stack, debugIds: { "/home/canaryuser/c.js": "canary" } } });
  w.app.emit("render-process-gone", {}, new EventEmitter(), { reason: "canary", exitCode: "canary" });
  await settle(w);
  await settle(w);
  assert.equal(w.requests.length >= 3, true);
  for (const request of w.requests) assert.doesNotMatch(request.body, /canary/i);
});

test("AC-42: there is no user, no server name and no stable id, and two app starts give two session ids", async (t) => {
  const first = world(t, {});
  first.throwUncaught();
  await settle(first);
  const second = world(t, {});
  second.throwUncaught();
  await settle(second);
  const [one] = first.events(), [two] = second.events();
  for (const event of [one, two]) {
    for (const key of ["user", "server_name", "request", "device", "extra"]) assert.equal(key in event, false, key);
    assert.match(event.tags.session, /^[0-9a-f]{32}$/);
  }
  assert.notEqual(one.tags.session, two.tags.session);
  assert.notEqual(one.event_id, two.event_id);
  const stored = fs.readdirSync(first.queueDir).map((name) => fs.readFileSync(join(first.queueDir, name), "utf8")).join("");
  assert.equal(stored.includes(one.tags.session), false, "the session id is kept only in memory");
});

test("AC-45: only the allowed breadcrumbs reach a report", async (t) => {
  const w = world(t, {});
  w.ipcMain.send("desktop-crash-reports:page", { sender: new EventEmitter() }, "chat");
  w.ipcMain.send("desktop-crash-reports:page", { sender: new EventEmitter() }, "https://example.test/secret");
  w.app.emit("child-process-gone", {}, { type: "GPU", reason: "abnormal-exit", exitCode: 1 });
  w.throwUncaught();
  await settle(w);
  const [event] = w.events().filter((entry) => entry.tags.kind === "main-error");
  assert.deepEqual(event.breadcrumbs.map((crumb) => `${crumb.category}:${crumb.message}`), ["app.start:app started", "page:page chat", "page:page other", "process:gpu gone"]);
});

test("AC-46: the request holds one event item and nothing else, even for a native crash", async (t) => {
  const w = world(t, {});
  w.app.emit("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: 1 });
  w.throwUncaught();
  await settle(w);
  assert.equal(w.requests.length, 2);
  for (const lines of w.bodies()) {
    assert.equal(lines.length, 4);
    assert.equal(JSON.parse(lines[1]).type, "event");
    assert.equal(JSON.parse(lines[2]).event_id, JSON.parse(lines[0]).event_id);
  }
});

test("AC-47: five restarts of the server with one error are one report; AC-47 also holds for the same exit code", async (t) => {
  const w = world(t, {});
  const proc = { postMessage() {} };
  for (let n = 0; n < 5; n++) w.reports.receive(proc, { type: "seira:crash-report", requestId: `request-${n}0`, report: { kind: "server-exit", errorName: "TypeError", stack: SERVER_STACK } });
  for (let n = 0; n < 5; n++) w.reports.serverExit({}, 1);
  w.liveTimers().filter((timer) => timer.ms === 3_000).forEach((timer) => timer.fn());
  await settle(w);
  assert.deepEqual(w.events().map((event) => event.tags.exit_code ?? "stack").sort(), ["1", "stack"]);
  const next = w.restart();
  next.reports.receive(proc, { type: "seira:crash-report", requestId: "request-new", report: { kind: "server-exit", errorName: "TypeError", stack: SERVER_STACK } });
  assert.equal(next.waiting().length, 1, "a new app start reports it again");
});

test("AC-48: after 10 reports in 60 minutes nothing is sent until the oldest is 60 minutes old", async (t) => {
  const w = world(t, {});
  const proc = { postMessage() {} };
  w.timers.find((timer) => timer.ms === 10_000).fn();
  const fail = (n) => w.reports.receive(proc, { type: "seira:crash-report", requestId: `request-${n}`, report: { kind: "server-turn", errorName: "Error", stack: `Error\n    at f${n} (/opt/Seira/resources/server/a.js:${n}:1)` } });
  for (let n = 1; n <= 10; n++) { fail(n); await settle(w); w.clock.now += 1_000; }
  assert.equal(w.requests.length, 10);
  fail(11);
  await settle(w);
  assert.equal(w.requests.length, 10, "the eleventh waits");
  assert.equal(w.waiting().length, 1);
  assert.ok(w.liveTimers().some((timer) => timer.ms > 59 * MINUTE && timer.ms <= 60 * MINUTE), "a wake is set for when the oldest send is 60 minutes old");
  w.clock.now += 59 * MINUTE;
  await settle(w);
  assert.equal(w.requests.length, 10, "the second send is still inside the hour");
  w.clock.now += 2 * MINUTE;
  await settle(w);
  assert.equal(w.requests.length, 11);
  assert.equal(w.waiting().length, 0);
});

test("AC-52: a 429 drops that report and sends nothing until the Retry-After time, also after a restart", async (t) => {
  const w = world(t, { answers: [{ status: 429, headers: { "retry-after": "120" } }] });
  const proc = { postMessage() {} };
  const report = (n) => w.reports.receive(proc, { type: "seira:crash-report", requestId: `request-${n}`, report: { kind: "server-turn", errorName: "Error", stack: `Error\n    at g${n} (/opt/Seira/resources/server/a.js:${n}:1)` } });
  w.timers.find((timer) => timer.ms === 10_000).fn();
  report(1);
  await settle(w);
  assert.equal(w.requests.length, 1);
  assert.equal(w.waiting().length, 0, "the report that got 429 is dropped");
  const state = JSON.parse(fs.readFileSync(join(w.queueDir, "state.json"), "utf8"));
  assert.equal(state.retryAfterUntil, w.clock.now + 120_000);
  report(2);
  await settle(w);
  assert.equal(w.requests.length, 1, "nothing before the time");
  assert.equal(w.waiting().length, 1);
  assert.ok(w.liveTimers().some((timer) => timer.ms === 120_000));
  const next = w.restart();
  next.timers.find((timer) => timer.ms === 10_000).fn();
  await settle(next);
  assert.equal(next.requests.length, 0, "a restart does not clear the wait");
  w.clock.now += 121_000;
  next.timers.find((timer) => timer.ms === 10_000).fn();
  await settle(next);
  assert.equal(next.requests.length, 1);
  assert.equal(next.waiting().length, 0);
});

test("AC-52: a 429 without a usable Retry-After waits 60 seconds", async (t) => {
  for (const header of [undefined, "soon", "-5"]) {
    const w = world(t, { answers: [{ status: 429, headers: header === undefined ? {} : { "retry-after": header } }] });
    w.throwUncaught();
    await settle(w);
    assert.equal(JSON.parse(fs.readFileSync(join(w.queueDir, "state.json"), "utf8")).retryAfterUntil, w.clock.now + 60_000, String(header));
  }
});

test("AC-53: another 4xx drops the report and it is never sent again", async (t) => {
  for (const status of [400, 403, 404, 413]) {
    const w = world(t, { answers: [{ status }] });
    w.throwUncaught();
    await settle(w);
    assert.equal(w.waiting().length, 0, String(status));
    await settle(w);
    assert.equal(w.requests.length, 1, String(status));
    assert.equal(w.logLines.some((line) => line.startsWith("event=crash-report")), false, "a dropped report is not logged as sent");
  }
});

test("AC-54: a build without an endpoint reports nothing and shows no switch, but keeps the local crash log", async (t) => {
  const w = world(t, { config: null });
  assert.equal(w.reports.available, false);
  assert.equal(w.ipcMain.read({}), null);
  await assert.rejects(async () => w.ipcMain.ask("desktop-crash-reports:set", {}, true), /not available/);
  w.throwUncaught(new Error("x"));
  w.ipcMain.send("desktop-crash-reports:renderer", {}, { kind: "renderer-error", errorName: "Error", message: "x", stack: "" });
  assert.equal(w.reports.receive({ postMessage() {} }, { type: "seira:crash-report", requestId: "request-off", report: {} }), false);
  await settle(w);
  assert.equal(w.requests.length, 0);
  assert.equal(fs.existsSync(w.queueDir), false);
  assert.deepEqual(w.crashReporter.starts, []);
  assert.deepEqual(w.liveTimers(), []);
  assert.deepEqual(w.reports.crashReportIds(), []);
  assert.equal(w.logLines.length, 1, "the local log still gets its main-process line");
  assert.match(w.logLines[0], /^event=main-process-failure/);
  assert.doesNotThrow(() => w.reports.hang({}));
  assert.doesNotThrow(() => w.reports.serverExit({}, 1));
  assert.doesNotThrow(() => w.reports.dispose());
});

test("AC-55: the endpoint comes from the build, or from a loopback value in a debug build, and nowhere else", async (t) => {
  const debug = world(t, { config: undefined, packaged: false, extra: { env: { SEIRA_CRASH_REPORT_URL: "http://127.0.0.1:4555/envelope" }, config: undefined } });
  debug.throwUncaught();
  await settle(debug);
  assert.equal(debug.requests[0].url, "http://127.0.0.1:4555/envelope");
  const packaged = world(t, { config: undefined, packaged: true, extra: { env: { SEIRA_CRASH_REPORT_URL: "http://127.0.0.1:4555/envelope" }, config: undefined } });
  packaged.throwUncaught();
  await settle(packaged);
  assert.equal(packaged.requests.length, 0);
  assert.equal(packaged.reports.available, false);
});

test("AC-24: a failing network, disk or fetch never reaches the caller and the app keeps running", async (t) => {
  const throwing = world(t, { extra: { fetch: () => { throw new Error("sync failure"); } } });
  assert.doesNotThrow(() => throwing.throwUncaught());
  await assert.doesNotReject(settle(throwing));
  assert.equal(throwing.waiting().length, 1, "kept for a later try");

  const full = world(t, { extra: { fs: new Proxy(fs, { get: (target, key) => (key === "writeFileSync" ? () => { throw new Error("ENOSPC"); } : target[key]) }) } });
  assert.doesNotThrow(() => full.throwUncaught());
  assert.doesNotThrow(() => full.reports.receive({ postMessage() {} }, { type: "seira:crash-report", requestId: "request-full", report: { kind: "server-turn", errorName: "Error", stack: "" } }));
  assert.doesNotThrow(() => full.reports.hang(new EventEmitter()));
  await settle(full);
  assert.equal(full.requests.length, 0);

  const odd = world(t, { extra: { os: { userInfo: () => { throw new Error("no passwd"); }, hostname: () => { throw new Error("none"); }, release: () => "6.8.0" } } });
  odd.throwUncaught();
  await settle(odd);
  assert.equal(odd.requests.length, 1);

  const prefsFail = world(t, {});
  prefsFail.prefs.crashReports = () => { throw new Error("prefs"); };
  assert.doesNotThrow(() => prefsFail.throwUncaught());
  assert.deepEqual(prefsFail.waiting(), [], "an unreadable switch means off");
});

test("a report waits when a send is already in flight, and the in-flight answer cannot resurrect a cleared queue", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const w = world(t, { extra: { fetch: async (url, init) => { await gate; return { status: 200, headers: { get: () => null }, body: null, url, init }; } } });
  w.throwUncaught();
  const pending = w.reports.flush();
  await w.ipcMain.ask("desktop-crash-reports:set", {}, false);
  release();
  await pending;
  assert.deepEqual(w.waiting(), []);
});

test("dispose removes every listener and timer", (t) => {
  const w = world(t, {});
  w.reports.dispose();
  assert.equal(w.processTarget.listenerCount("uncaughtExceptionMonitor"), 0);
  assert.equal(w.app.listenerCount("render-process-gone"), 0);
  assert.equal(w.app.listenerCount("child-process-gone"), 0);
  assert.deepEqual(w.liveTimers(), []);
});

test("AC-08: a stopped recovery is one renderer-stuck report for each reason, and none with the switch off", async (t) => {
  const w = world(t, {});
  w.reports.recoveryStopped({ reason: "launch-failed", exitCode: -36861, next: "dialog" });
  w.reports.recoveryStopped({ reason: "launch-failed", exitCode: 18, next: "dialog" });
  w.reports.recoveryStopped({ reason: "killed", exitCode: 1, next: "page" });
  await settle(w);
  const events = w.events();
  assert.deepEqual(events.map((event) => [event.tags.kind, event.tags.reason, event.tags.process]), [["renderer-stuck", "launch-failed", "renderer"], ["renderer-stuck", "killed", "renderer"]]);
  assert.equal(events[0].tags.exit_code, "-36861");
  const off = world(t, { on: false });
  off.reports.recoveryStopped({ reason: "crashed", exitCode: 1, next: "page" });
  await settle(off);
  assert.deepEqual(off.waiting(), []);
});
