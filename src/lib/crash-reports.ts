// The window's side of a crash report. The window sends an error to the desktop app's main process and nothing else:
// the main process checks the person's switch, filters, queues and sends. A browser tab, and a desktop build that has
// no crash report service, have no bridge, so this file does nothing there.
import { debugIdsByFile } from "../../shared/crash-debug-ids";

type Bridge = NonNullable<NonNullable<Window["ogb"]>["crashReports"]>;
type Report = Parameters<Bridge["report"]>[0];
export type CrashPageName = Parameters<Bridge["page"]>[0];

const MAX_REPORTS = 20;
const MESSAGE_MAX = 1024;
const STACK_MAX = 16 * 1024;

/** The bridge, only where it exists and the build can send reports. */
export const crashReportsBridge = (): Bridge | undefined => {
  const bridge = globalThis.window?.ogb?.crashReports;
  return bridge && bridge.available === true ? bridge : undefined;
};

let page: CrashPageName = "other";
let sent = 0;
const seen = new Set<string>();
let installed = false;
let onError: ((event: Event) => void) | undefined;
let onRejection: ((event: Event) => void) | undefined;

/** The frames of a stack, without a query or a hash on a file address. */
function framesOf(error: unknown): string {
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : "";
  return stack.split("\n").filter((line) => /^\s+at /.test(line)).map((line) => line.replace(/[?#][^\s):]*(?=:\d+:\d+)/g, "")).join("\n").slice(0, STACK_MAX);
}

function send(kind: Report["kind"], error: unknown): void {
  try {
    const bridge = crashReportsBridge();
    if (!bridge || sent >= MAX_REPORTS) return;
    const failure = error instanceof Error ? error : undefined;
    const name = failure?.name && /^[A-Za-z0-9_.$-]{1,64}$/.test(failure.name) ? failure.name : "Error";
    const stack = framesOf(error);
    const key = `${kind}|${name}|${stack.split("\n", 1)[0]}`;
    if (seen.has(key)) return;
    seen.add(key);
    sent++;
    const debugIds = debugIdsByFile((globalThis as { _sentryDebugIds?: unknown })._sentryDebugIds);
    bridge.report({ kind, errorName: name, message: (failure ? failure.message : "").slice(0, MESSAGE_MAX), stack, page, ...(debugIds ? { debugIds } : {}) });
  } catch {
    // A report that cannot be sent is dropped.
  }
}

/** An error that PageBoundary caught. */
export const reportPageBoundary = (error: unknown): void => send("page-boundary", error);

/** Tells the main process which page is visible; one call for each change. */
export function reportPage(name: CrashPageName): void {
  if (name === page) return;
  page = name;
  try { crashReportsBridge()?.page(name); } catch { /* the page name is only a hint */ }
}

/** The page name of what the window shows. */
export function pageName(view: { activeView: string; settingsOpen: boolean; firstRun: boolean }): CrashPageName {
  if (view.settingsOpen) return "settings";
  if (view.firstRun) return "onboarding";
  return view.activeView === "chat" ? "chat" : "other";
}

/** Listens for uncaught errors and unhandled rejections, once, and only where reports can be sent (AC-14). */
export function installCrashReports(): void {
  if (installed || !crashReportsBridge()) return;
  installed = true;
  onError = (event) => send("renderer-error", (event as ErrorEvent).error);
  onRejection = (event) => send("renderer-rejection", (event as PromiseRejectionEvent).reason);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
}

/** For tests: forget what the window already sent, and stop listening. */
export function resetCrashReportsForTest(): void {
  if (onError) window.removeEventListener("error", onError);
  if (onRejection) window.removeEventListener("unhandledrejection", onRejection);
  onError = onRejection = undefined;
  page = "other";
  sent = 0;
  seen.clear();
  installed = false;
}
