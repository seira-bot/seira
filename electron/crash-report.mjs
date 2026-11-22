// Crash reports of the desktop app. Main is the only place that decides: the page and the server pass what went wrong to
// main, and main checks the switch for every report, drops what the switch refuses, queues the rest on disk and sends it.
import nodeFs from "node:fs";
import nodeOs from "node:os";
import path from "node:path";
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { loadCrashReportConfig } from "./crash-report-config.mjs";
import { linuxPackageType } from "./package-install-command.mjs";
import { PROCESS_GONE_REASONS, formatDesktopCrashRecord, installDesktopCrashListeners } from "./diagnostics.mjs";
import { buildEnvelope, buildEvent, detectPackageType } from "./crash-report-event.mjs";
import { fromRendererReport, fromServerReport, pageName, validRequestId } from "./crash-report-input.mjs";
import { takeCrashDumps } from "./crash-report-native.mjs";
import { createCrashQueue } from "./crash-report-queue.mjs";

export const SEND_TIMEOUT_MS = 10_000;
export const FIRST_SEND_DELAY_MS = 10_000;
export const RETRY_INTERVAL_MS = 5 * 60_000;
export const SENT_WINDOW_MS = 60 * 60_000;
export const SENT_PER_WINDOW = 10;
export const DEFAULT_RETRY_AFTER_MS = 60_000;
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000;
export const SERVER_EXIT_GRACE_MS = 3_000;
/** Main passes this to this app's own pages only when the build can send reports, so the preload knows without a sync call at load. */
export const CRASH_REPORTS_ARG = "--seira-crash-reports=1";
const HANG_SUPPRESS_MS = 10_000;
const ID_DAYS = 7;
const QUIET_SERVER_EXITS = new Set([0, 70, 75]);
const DUMP_REASONS = new Set(["crashed", "oom"]);
const CHILD_PROCESS = { GPU: "gpu", Utility: "utility" };

const inert = Object.freeze({
  available: false,
  receive: () => false,
  hang() {},
  recoveryStopped() {},
  stopping() {},
  serverExit() {},
  crashReportIds: () => [],
  switchOn: () => false,
  flush: async () => {},
  dispose() {},
});

function retryAfterMs(response) {
  const raw = response.headers?.get?.("retry-after");
  const seconds = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(Math.max(Math.round(seconds * 1000), 1000), MAX_RETRY_AFTER_MS);
}

const safe = (fn) => { try { return fn(); } catch { return undefined; } };

/**
 * `config`: { url, environment } or null (crash reporting off); left out, it comes from the build (crash-report-config.mjs). `prefs`: { crashReports(), setCrashReports(on) }, the one
 * record main keeps. `fetch`: net.fetch in the app. `schedule(fn, ms)`: a timer that never keeps the app alive.
 * `isLocalSender(event)`: true for this computer's own page. `appendCrashLog(line)`: one line of desktop-crashes.log.
 */
export function createCrashReports({
  app, ipcMain, crashReporter, fetch: sendRequest, config: given, prefs, userData, appendCrashLog = () => {}, isShuttingDown = () => false,
  mainWebContents = () => null, isLocalSender = () => false, processTarget = process, env = process.env, platform = process.platform,
  os = nodeOs, fs = nodeFs, now = Date.now, randomBytes = nodeRandomBytes, roots = [], packageMarker,
  schedule = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; }, cancel = clearTimeout,
  firstSendDelayMs = FIRST_SEND_DELAY_MS, retryIntervalMs = RETRY_INTERVAL_MS, serverExitGraceMs = SERVER_EXIT_GRACE_MS,
}) {
  const config = given === undefined ? loadCrashReportConfig({ app, env }) : given;
  const record = (event) => appendCrashLog(formatDesktopCrashRecord(event));
  // The local log keeps working in a build without an endpoint: it never leaves this computer.
  const removeLocalListeners = installDesktopCrashListeners({ appTarget: app, processTarget, record, isShuttingDown, mainWebContents });
  const switchOn = () => safe(() => prefs.crashReports() === true) === true;
  const readSwitch = (event) => (isLocalSender(event) ? (config ? switchOn() : null) : null);

  ipcMain.on("desktop-crash-reports:read", (event) => { event.returnValue = safe(() => readSwitch(event)) ?? null; });
  if (!config) {
    ipcMain.handle("desktop-crash-reports:set", () => { throw new Error("Crash reports are not available in this build"); });
    return { ...inert, dispose: removeLocalListeners };
  }

  const queue = createCrashQueue({ dir: path.join(userData, "crash-reports"), fs, now });
  const session = randomBytes(16).toString("hex");
  const username = safe(() => os.userInfo().username) ?? "";
  const hostname = safe(() => os.hostname()) ?? "";
  const marker = packageMarker !== undefined ? packageMarker
    : platform === "linux" && app.isPackaged === true ? safe(() => linuxPackageType({ readMarker: (file) => fs.readFileSync(file, "utf8") })) : null;
  const packageType = detectPackageType({ isPackaged: app.isPackaged === true, platform, env, windowsStore: processTarget.windowsStore === true, marker });
  const seen = new Set();
  const breadcrumbs = [];
  const pages = new WeakMap();
  const stopping = new WeakSet();
  const hung = new WeakMap();
  const utilityGone = [];
  let childCrashes = 0;
  let flushing = false;
  let wake = null;
  let wakeAt = Infinity;
  let nativeStarted = false;
  const startedAt = now();

  function addBreadcrumb(category, message) {
    breadcrumbs.push({ timestamp: now() / 1000, category, message });
    if (breadcrumbs.length > 20) breadcrumbs.shift();
  }

  const writeMarker = (clean = false) => queue.writeJson("session.json", { startedAt, clean, on: switchOn(), childCrashes });

  function startNativeReporter() {
    if (nativeStarted || !switchOn()) return;
    nativeStarted = true;
    // Electron 43: with uploadToServer false, Crashpad keeps dumps on disk and sends nothing. They are counted and deleted, never read.
    safe(() => crashReporter.start({ uploadToServer: false, compress: false }));
  }

  function arm(delayMs) {
    const at = now() + delayMs;
    if (wake !== null && wakeAt <= at) return;
    if (wake !== null) cancel(wake);
    wakeAt = at;
    wake = schedule(() => { wake = null; wakeAt = Infinity; void flush(); }, delayMs);
  }

  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      for (;;) {
        if (!switchOn()) return;
        const state = queue.state();
        const current = now();
        if (state.retryAfterUntil > current) { arm(state.retryAfterUntil - current); return; }
        const recent = state.sent.filter((item) => item.at > current - SENT_WINDOW_MS);
        if (recent.length >= SENT_PER_WINDOW) { arm(Math.min(...recent.map((item) => item.at)) + SENT_WINDOW_MS - current); return; }
        const entry = queue.list()[0];
        if (!entry) return;
        const body = queue.read(entry);
        if (body === null) { queue.remove(entry); continue; }
        let response;
        try {
          response = await sendRequest(config.url, {
            method: "POST",
            headers: { "content-type": "application/x-sentry-envelope" },
            body,
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          });
        } catch {
          arm(retryIntervalMs);
          return;
        }
        safe(() => response.body?.cancel?.());
        const status = Number(response.status);
        if (status >= 200 && status < 300) {
          queue.remove(entry);
          const latest = queue.state();
          queue.saveState({ ...latest, sent: [...latest.sent, { at: now(), id: entry.id }] });
          record({ kind: "crash-report", id: entry.id, reportKind: entry.kind });
        } else if (status === 429) {
          queue.remove(entry);
          const latest = queue.state();
          queue.saveState({ ...latest, retryAfterUntil: now() + retryAfterMs(response) });
        } else if (status >= 400 && status < 500) {
          queue.remove(entry);
        } else {
          arm(retryIntervalMs);
          return;
        }
      }
    } catch {
      arm(retryIntervalMs);
    } finally {
      flushing = false;
    }
  }

  /** The one way into the queue. Returns true when the report was stored. */
  function capture(report) {
    try {
      if (!switchOn()) return false;
      const built = buildEvent(report, {
        eventId: randomBytes(16).toString("hex"), timestamp: now() / 1000, appVersion: app.getVersion(), environment: config.environment,
        packageType, session, platform, osVersion: typeof processTarget.getSystemVersion === "function" ? safe(() => processTarget.getSystemVersion()) : os.release(),
        electronVersion: processTarget.versions?.electron, username, hostname, roots, breadcrumbs,
      });
      if (!built || seen.has(built.signature)) return false;
      seen.add(built.signature);
      const stored = queue.add(built.event.event_id, report.kind, buildEnvelope(built.event, new Date(now()).toISOString()));
      if (stored) void flush();
      return stored;
    } catch {
      return false;
    }
  }

  function countDump(reason) {
    if (!DUMP_REASONS.has(reason)) return;
    childCrashes += 1;
    writeMarker();
  }

  const onMainFailure = (error) => {
    capture({ kind: "main-error", process: "main", errorName: safe(() => error?.name), message: safe(() => error?.message), stack: safe(() => error?.stack) });
  };
  const onRendererGone = (_event, contents, details) => {
    const reason = details?.reason;
    if (reason === "clean-exit") return;
    countDump(reason);
    addBreadcrumb("process", "renderer gone");
    const until = hung.get(contents);
    if (until !== undefined) { hung.delete(contents); if (now() <= until) return; }
    if (isShuttingDown()) return;
    capture({ kind: "native", process: "renderer", reason, exitCode: details?.exitCode });
  };
  const onChildGone = (_event, details) => {
    const reason = details?.reason;
    if (reason === "clean-exit") return;
    countDump(reason);
    const process = Object.hasOwn(CHILD_PROCESS, details?.type) ? CHILD_PROCESS[details.type] : null;
    if (process === "utility") { utilityGone.push(now()); if (utilityGone.length > 20) utilityGone.shift(); }
    if (process) addBreadcrumb("process", `${process} gone`);
    if (isShuttingDown() || !process || !PROCESS_GONE_REASONS.has(reason)) return;
    capture({ kind: "native", process, reason, exitCode: details?.exitCode });
  };
  processTarget.on("uncaughtExceptionMonitor", onMainFailure);
  app.on("render-process-gone", onRendererGone);
  app.on("child-process-gone", onChildGone);

  ipcMain.on("desktop-crash-reports:renderer", (event, raw) => {
    if (!safe(() => isLocalSender(event))) return;
    const report = safe(() => fromRendererReport(raw));
    if (report) capture(report);
  });
  ipcMain.on("desktop-crash-reports:page", (event, name) => {
    if (!safe(() => isLocalSender(event))) return;
    const page = pageName(name);
    safe(() => pages.set(event.sender, page));
    addBreadcrumb("page", `page ${page}`);
  });
  ipcMain.handle("desktop-crash-reports:set", (event, on) => {
    if (!isLocalSender(event)) throw new Error("desktop-crash-reports:set is only available in this app's window");
    prefs.setCrashReports(on === true);
    if (switchOn()) { startNativeReporter(); void flush(); } else queue.clear();
    writeMarker();
  });

  function judgePreviousRun() {
    const previous = queue.readJson("session.json");
    const crashed = previous?.clean === false && previous.on === true && Number.isFinite(previous.startedAt);
    const fresh = takeCrashDumps({ dir: safe(() => app.getPath("crashDumps")) ?? "", since: crashed ? previous.startedAt : Infinity, fs });
    if (crashed && fresh > (Number.isFinite(previous.childCrashes) ? previous.childCrashes : 0)) {
      capture({ kind: "native", process: "main", reason: "crashed" });
    }
  }

  safe(() => app.on("will-quit", () => writeMarker(true)));
  if (!switchOn()) queue.clear();
  judgePreviousRun();
  writeMarker();
  startNativeReporter();
  addBreadcrumb("app.start", "app started");
  arm(firstSendDelayMs);
  let timerRepeat = null;
  const repeat = () => { void flush(); timerRepeat = schedule(repeat, retryIntervalMs); };
  timerRepeat = schedule(repeat, retryIntervalMs);

  return {
    available: true,
    switchOn,
    flush,
    /** Server messages of K1: true when the message was a crash report, whatever became of it. */
    receive(proc, message) {
      if (message?.type !== "seira:crash-report") return false;
      if (!validRequestId(message.requestId)) return true;
      const report = safe(() => fromServerReport(message.report));
      if (report) capture(report);
      safe(() => proc.postMessage({ type: "seira:crash-report-ack", requestId: message.requestId }));
      return true;
    },
    /** The window's page has not answered: call before forcing it to end, so that forced end is not a second report. */
    hang(contents) {
      addBreadcrumb("process", "renderer unresponsive");
      safe(() => hung.set(contents, now() + HANG_SUPPRESS_MS));
      capture({ kind: "hang", process: "renderer", page: safe(() => pages.get(contents)) ?? "other" });
    },
    /** The main window's page ended too often to reload: one report for each reason in a session. */
    recoveryStopped(stop) {
      capture({ kind: "renderer-stuck", process: "renderer", reason: stop?.reason, exitCode: stop?.exitCode });
    },
    /** Main asks the server to stop: its exit is then on purpose. */
    stopping(proc) { if (proc) stopping.add(proc); },
    serverExit(proc, code) {
      if (stopping.has(proc) || isShuttingDown() || QUIET_SERVER_EXITS.has(code)) return;
      const at = now();
      addBreadcrumb("process", "server exited");
      schedule(() => {
        if (isShuttingDown()) return;
        if (utilityGone.some((when) => Math.abs(when - at) <= serverExitGraceMs)) return;
        capture({ kind: "server-exit", process: "server", exitCode: code });
      }, serverExitGraceMs);
    },
    /** Ids of the reports sent in the last `days` days, newest last. */
    crashReportIds(days = ID_DAYS) {
      const cutoff = now() - days * 24 * 60 * 60_000;
      return queue.state().sent.filter((item) => item.at >= cutoff).map((item) => item.id);
    },
    dispose() {
      removeLocalListeners();
      processTarget.off("uncaughtExceptionMonitor", onMainFailure);
      app.off("render-process-gone", onRendererGone);
      app.off("child-process-gone", onChildGone);
      if (wake !== null) cancel(wake);
      if (timerRepeat !== null) cancel(timerRepeat);
    },
  };
}
