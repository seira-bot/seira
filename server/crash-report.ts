// The server's side of a crash report. A server that the desktop app runs as a utility process hands the report to the
// app's main process through its parent port. The main process checks the person's switch, filters, queues and sends.
// The server opens no connection of its own, and a server without a parent port (Docker, `seira serve`, Seira Cloud)
// sends nothing.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

import { debugIdsByFile } from "../shared/crash-debug-ids.ts";
import { redactSecretsInText } from "./redact.ts";

export type CrashReportKind = "server-exit" | "server-turn";

/** What the crash guard knows when it files a report. */
export interface CrashReportInput { kind: CrashReportKind; error: unknown; engine?: string }

/** The message the main process receives. It carries no bot name, thread id, prompt or environment value. */
export interface CrashReport {
  kind: CrashReportKind;
  errorName: string;
  errorCode?: string;
  message: string;
  stack: string;
  engine?: string;
  debugIds?: Record<string, string>;
}

export interface CrashParentPort {
  on(event: "message", listener: (event: { data?: unknown }) => void): void;
  postMessage(message: object): void;
}

export const CRASH_ACK_WAIT_MS = 2_000;
export const CRASH_STACK_MAX = 16 * 1024;
export const CRASH_MESSAGE_MAX = 1024;

/** The engines the server knows. Any other engine, such as one a person added, is reported as "custom". */
export const CRASH_ENGINES: ReadonlySet<string> = new Set([
  "claudeAgent", "codex", "grok", "minimax", "museCode", "piAgent", "antigravityAgent", "opencodeGo",
  "cerebras", "groq", "mistral", "meta", "modelgo", "greenference", "openai-compat",
]);

export const crashEngine = (driverKind: string | undefined): string | undefined =>
  driverKind === undefined ? undefined : CRASH_ENGINES.has(driverKind) ? driverKind : "custom";

const safeToken = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && /^[A-Za-z0-9_.$-]+$/.test(value) ? value.slice(0, max) : undefined;

/** The main process accepts a file of ours only in this form; it makes any other relative name <external>. */
const appFile = (folder: string, rest: string) => `app:///${folder === "ui" ? "ui" : "server"}/${rest.replaceAll("\\", "/")}`;

/** Keeps each debug id key from its bundle folder onward, so no folder of the person's computer leaves. A key with no bundle folder is dropped. */
function bundleIds(ids: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!ids) return undefined;
  const kept: Record<string, string> = {};
  for (const [file, id] of Object.entries(ids)) {
    const match = /^.*\/(dist-server|server|ui)\/(.+)$/.exec(file.replaceAll("\\", "/"));
    if (match) kept[appFile(match[1], match[2])] = id;
  }
  return Object.keys(kept).length ? kept : undefined;
}

const ABSOLUTE_PATH = /(?:file:\/\/)?(?:[A-Za-z]:)?[\\/](?:[^\s'"():,;<>]+[\\/])+[^\s'"():,;<>]*/g;
const BUNDLE_PART = /^.*[\\/](dist-server|server|ui)[\\/](.+)$/;

/** The text of an error without a folder of the person's computer, and without a secret. */
function cleanText(text: string): string {
  let out = text;
  try { const home = homedir(); if (home.length > 3) out = out.split(home).join("~"); } catch { /* no home folder */ }
  return redactSecretsInText(out.replace(ABSOLUTE_PATH, "<path>"));
}

/** A frame line with its file shortened to the part from the bundle folder onward; a file outside the bundles becomes <external>. */
function cleanFrame(line: string): string {
  const redacted = redactSecretsInText(line);
  return redacted.replace(ABSOLUTE_PATH, (path) => {
    const match = BUNDLE_PART.exec(path.replace(/^file:\/\//, ""));
    return match ? appFile(match[1], match[2]) : "<external>";
  });
}

export function buildCrashReport(input: CrashReportInput, debugTable: unknown = (globalThis as { _sentryDebugIds?: unknown })._sentryDebugIds): CrashReport {
  const error = input.error;
  const failure = error instanceof Error ? error : undefined;
  const code = (error as { code?: unknown } | null)?.code;
  // Only the stack frames go: the first lines of a stack repeat the message.
  const frames = failure?.stack ? failure.stack.split("\n").filter((line) => /^\s+at /.test(line)).map(cleanFrame).join("\n") : "";
  const report: CrashReport = {
    kind: input.kind,
    errorName: safeToken(failure?.name, 64) ?? typeof error,
    message: cleanText(failure ? failure.message : String(error)).slice(0, CRASH_MESSAGE_MAX),
    stack: frames.slice(0, CRASH_STACK_MAX),
  };
  const errorCode = safeToken(code, 64);
  if (errorCode) report.errorCode = errorCode;
  const engine = crashEngine(input.engine);
  if (engine) report.engine = engine;
  const debugIds = bundleIds(debugIdsByFile(debugTable));
  if (debugIds) report.debugIds = debugIds;
  return report;
}

export interface CrashReporterDeps {
  port?: () => CrashParentPort | undefined;
  ackWaitMs?: number;
  newId?: () => string;
}

const parentPort = (): CrashParentPort | undefined => (process as NodeJS.Process & { parentPort?: CrashParentPort }).parentPort;

/** Posts a report to the main process. It resolves when the main process answers, or after ackWaitMs. It never throws. */
export function createCrashReporter(deps: CrashReporterDeps = {}): (input: CrashReportInput) => Promise<void> {
  const getPort = deps.port ?? parentPort, wait = deps.ackWaitMs ?? CRASH_ACK_WAIT_MS, newId = deps.newId ?? randomUUID;
  const waiting = new Map<string, () => void>();
  let listening: CrashParentPort | undefined;
  return (input) => {
    try {
      const port = getPort();
      if (!port) return Promise.resolve();
      if (listening !== port) {
        listening = port;
        port.on("message", (event) => {
          const message = event?.data as { type?: unknown; requestId?: unknown } | undefined;
          if (message?.type !== "seira:crash-report-ack" || typeof message.requestId !== "string") return;
          waiting.get(message.requestId)?.();
        });
      }
      const requestId = newId();
      return new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); waiting.delete(requestId); resolve(); };
        const timer = setTimeout(done, wait);
        waiting.set(requestId, done);
        try { port.postMessage({ type: "seira:crash-report", requestId, report: buildCrashReport(input) }); } catch { done(); }
      });
    } catch {
      return Promise.resolve();
    }
  };
}

export const reportCrash = createCrashReporter();
