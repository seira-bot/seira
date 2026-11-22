// Privacy by construction: an event is assembled from fixed fields and values that pass an allowlist, never copied from the
// error and cleaned afterwards. Nothing here reads a user name, a host name, a path or a message except to refuse it.
import { ERROR_NAMES, PROCESS_GONE_REASONS, CRASH_REPORT_KINDS, known } from "./diagnostics.mjs";

export const MAX_FRAMES = 30;
export const MAX_BREADCRUMBS = 20;
export const MAX_MESSAGE_LENGTH = 200;
export const PAGE_NAMES = Object.freeze(["chat", "settings", "onboarding", "rail", "other"]);
const PROCESS_NAMES = new Set(["main", "renderer", "gpu", "utility", "server"]);
const FATAL_KINDS = new Set(["main-error", "native", "server-exit"]);

export const BREADCRUMB_MESSAGES = Object.freeze({
  "app.start": ["app started"],
  page: PAGE_NAMES.map((name) => `page ${name}`),
  process: ["renderer gone", "gpu gone", "utility gone", "server exited", "renderer unresponsive"],
});

const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,40}$/;
const FUNCTION_NAME = /^[\w$.<>[\] ]{1,80}$/;
const ENGINE = /^[a-z][a-z0-9-]{0,24}$/;
const DEBUG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_REST = /^[\w./@+-]{1,200}$/;
const UI_REST = /^assets\/[\w./@+-]{1,180}$/;
const NODE_FILE = /^[\w/.-]{1,80}$/;
const VERSION = /^[\w.+-]{1,40}$/;
const EXTERNAL = "<external>";
const OS_NAMES = { linux: "Linux", darwin: "macOS", win32: "Windows" };
const FIRST_SEGMENTS = { electron: "electron", server: "server", "dist-server": "server", ui: "ui" };

/** Our own files only: the page's scripts are the hashed files under assets/, whatever the rest of its address says. */
function safeTail(first, tail) {
  return (first === "ui" ? UI_REST : SAFE_REST).test(tail) && !tail.split("/").includes("..");
}

const contains = (text, needle) => needle.length >= 2 && text.toLowerCase().includes(needle.toLowerCase());
const namesPerson = (file, username, hostname) => {
  const parts = file.toLowerCase().split("/").flatMap((part) => [part, part.split(".")[0]]);
  return [username, hostname].some((name) => name.length >= 2 && parts.includes(name.toLowerCase()));
};

/** The message of an error, or null. Free text can carry a path, an address, a name or a prompt: only a short message with none of those shapes passes. */
export function filterMessage(message, { username = "", hostname = "" } = {}) {
  if (typeof message !== "string" || message.length === 0 || message.length > MAX_MESSAGE_LENGTH) return null;
  if ([...message].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
  if (/[\\/@]/.test(message)) return null;
  if (/\d{6,}/.test(message)) return null;
  if (/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(message)) return null;
  if (/(["'`])[^"'`]*\1/.test(message)) return null;
  // Two capitalized words in a row read as a person's or a bot's name; engine messages do not have them.
  if (/\b[A-Z][a-z]+\s+[A-Z][a-z]+/.test(message)) return null;
  if (contains(message, username) || contains(message, hostname)) return null;
  return message;
}

function fileUrlPath(file) {
  let path = file.slice("file://".length);
  try { path = decodeURIComponent(path); } catch { return null; }
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  return path;
}

function fromRoots(path, roots) {
  const clean = path.replaceAll("\\", "/");
  for (const root of roots) {
    const base = typeof root === "string" ? root.replaceAll("\\", "/").replace(/\/+$/, "") : "";
    if (!base || !clean.startsWith(`${base}/`)) continue;
    const rest = clean.slice(base.length + 1).replace(/^app\.asar(?:\.unpacked)?\//, "");
    const slash = rest.indexOf("/");
    const head = slash < 0 ? "" : rest.slice(0, slash);
    const first = Object.hasOwn(FIRST_SEGMENTS, head) ? FIRST_SEGMENTS[head] : null;
    const tail = slash < 0 ? "" : rest.slice(slash + 1);
    if (first && safeTail(first, tail)) return `app:///${first}/${tail}`;
  }
  return null;
}

/** The only file names that leave this computer: our own files under a fixed prefix, or a Node built-in. */
export function normalizeFile(file, roots = []) {
  if (typeof file !== "string" || file.length === 0 || file.length > 1024) return EXTERNAL;
  if (file.startsWith("node:")) return NODE_FILE.test(file.slice(5)) ? file : EXTERNAL;
  const web = /^https?:\/\/[^/?#]+\/([^?#]*)/i.exec(file);
  if (web) return safeTail("ui", web[1]) ? `app:///ui/${web[1]}` : EXTERNAL;
  const app = /^app:\/\/\/(electron|server|ui)\/([^?#]*)$/.exec(file);
  if (app) return safeTail(app[1], app[2]) ? file : EXTERNAL;
  const path = file.startsWith("file://") ? fileUrlPath(file) : file;
  return (path && fromRoots(path, roots)) || EXTERNAL;
}

const FRAME_LINE = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d{1,9}):(\d{1,9})\)?\s*$/;

/** V8 stack text to frames, newest first. A frame outside our files keeps a line and column but no function name. */
export function parseFrames(stack, { roots = [], username = "", hostname = "" } = {}) {
  if (typeof stack !== "string") return [];
  const frames = [];
  for (const line of stack.slice(0, 50_000).split("\n")) {
    const match = FRAME_LINE.exec(line);
    if (!match) continue;
    const named = normalizeFile(match[2], roots);
    // A file name from another process is trusted only up to its shape: a part equal to the user or computer name drops it.
    const filename = namesPerson(named, username, hostname) ? EXTERNAL : named;
    const frame = { filename, lineno: Number(match[3]), colno: Number(match[4]), in_app: filename.startsWith("app:///") };
    const name = match[1]?.replace(/^async /, "");
    if (filename !== EXTERNAL && name && FUNCTION_NAME.test(name) && !contains(name, username) && !contains(name, hostname)) frame.function = name;
    frames.push(frame);
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames;
}

/** Package type words are fixed: the file the installer wrote, or the sandbox the app runs in. */
export function detectPackageType({ isPackaged, platform = process.platform, env = process.env, windowsStore = false, marker = null }) {
  if (!isPackaged) return "dev";
  if (windowsStore === true) return "msix";
  if (platform === "win32") return "nsis";
  if (platform === "darwin") return "dmg";
  if (env.FLATPAK_ID) return "flatpak";
  if (env.SNAP) return "snap";
  if (env.APPIMAGE) return "appimage";
  const declared = typeof marker === "string" ? marker.trim().toLowerCase() : "";
  return ["deb", "pacman", "flatpak", "snap"].includes(declared) ? declared : "linux";
}

const ENGINE_ERROR_TYPES = new Set(["TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError"]);
const exitCodeText = (value) => (Number.isSafeInteger(value) ? String(value) : "unknown");

function describeProcess(report, type) {
  // No text of its own: the tags (kind, process, reason, exit_code) already say what happened.
  if (report.kind === "native" || report.kind === "hang") return { type: "Error", value: null };
  if (report.kind === "server-exit" && report.exitCode !== undefined && report.stack === undefined) return { type: "Error", value: null };
  return { type, value: null };
}

/** The key two reports share when they describe one failure: error type and the top three frames, or the fixed words for a failure with no stack. */
export function crashSignature(report, frames, type) {
  if (report.kind === "native") return `native:${report.process}:${known(report.reason, PROCESS_GONE_REASONS)}`;
  if (report.kind === "hang") return `hang:${report.page}`;
  if (report.kind === "server-exit" && report.exitCode !== undefined && report.stack === undefined) return `server-exit:${exitCodeText(report.exitCode)}`;
  const top = frames.slice(0, 3).map((frame) => `${frame.function ?? ""}@${frame.filename}:${frame.lineno}`);
  return [report.kind, type, ...top].join("|");
}

function debugImages(frames, debugIds, roots, username = "", hostname = "") {
  const byFile = new Map();
  if (debugIds && typeof debugIds === "object") {
    for (const [file, id] of Object.entries(debugIds).slice(0, 50)) {
      const normalized = normalizeFile(file, roots);
      if (normalized !== EXTERNAL && !namesPerson(normalized, username, hostname) && typeof id === "string" && DEBUG_ID.test(id)) byFile.set(normalized, id.toLowerCase());
    }
  }
  const images = [];
  for (const file of new Set(frames.map((frame) => frame.filename))) {
    if (byFile.has(file)) images.push({ type: "sourcemap", code_file: file, debug_id: byFile.get(file) });
  }
  return images;
}

function cleanBreadcrumbs(breadcrumbs) {
  if (!Array.isArray(breadcrumbs)) return [];
  const kept = [];
  for (const crumb of breadcrumbs) {
    const allowed = Object.hasOwn(BREADCRUMB_MESSAGES, crumb?.category) ? BREADCRUMB_MESSAGES[crumb.category] : [];
    if (!allowed.includes(crumb?.message) || !Number.isFinite(crumb?.timestamp)) continue;
    kept.push({ timestamp: crumb.timestamp, category: crumb.category, message: crumb.message, level: "info" });
  }
  return kept.slice(-MAX_BREADCRUMBS);
}

/**
 * `report`: { kind, process, errorName?, errorCode?, message?, stack?, reason?, exitCode?, engine?, page?, debugIds? }.
 * `context`: facts about this run, none of them about the person: see buildContext in crash-report.mjs.
 * Returns { event, signature }, or null for a report with an unknown kind.
 */
export function buildEvent(report, context) {
  if (!CRASH_REPORT_KINDS.has(report?.kind) || !PROCESS_NAMES.has(report.process)) return null;
  const { username = "", hostname = "", roots = [] } = context;
  const page = PAGE_NAMES.includes(report.page) ? report.page : report.page === undefined && report.kind !== "hang" ? undefined : "other";
  const frames = parseFrames(report.stack, { roots, username, hostname });
  const named = known(report.errorName, ERROR_NAMES, "Error");
  const described = describeProcess({ ...report, page }, named);
  const signature = crashSignature({ ...report, page }, frames, described.type);
  // Free text can hold a name that no pattern catches, so only a built-in engine error type may carry its message.
  const value = ENGINE_ERROR_TYPES.has(described.type) ? filterMessage(report.message, { username, hostname }) : null;
  const tags = {
    kind: report.kind,
    process: report.process,
    package: context.packageType,
    session: context.session,
  };
  if (typeof report.reason === "string") tags.reason = known(report.reason, PROCESS_GONE_REASONS);
  if (report.exitCode !== undefined) tags.exit_code = exitCodeText(report.exitCode);
  if (typeof report.engine === "string") tags.engine = ENGINE.test(report.engine) ? report.engine : "custom";
  if (page) tags.page = page;
  if (typeof report.errorCode === "string" && ERROR_CODE.test(report.errorCode)) tags.error_code = report.errorCode;
  const exception = { type: described.type, ...(value ? { value } : {}) };
  if (frames.length) exception.stacktrace = { frames: [...frames].reverse() };
  const images = debugImages(frames, report.debugIds, roots, username, hostname);
  const event = {
    event_id: context.eventId,
    timestamp: context.timestamp,
    platform: "javascript",
    level: FATAL_KINDS.has(report.kind) ? "fatal" : "error",
    release: `seira@${VERSION.test(context.appVersion) ? context.appVersion : "unknown"}`,
    environment: context.environment,
    sdk: { name: "seira.crash-report", version: "1" },
    tags,
    contexts: {
      os: { name: OS_NAMES[context.platform] ?? "Other", version: typeof context.osVersion === "string" && VERSION.test(context.osVersion) ? context.osVersion : "unknown" },
      app: { app_version: VERSION.test(context.appVersion) ? context.appVersion : "unknown" },
      runtime: { name: "electron", version: typeof context.electronVersion === "string" && VERSION.test(context.electronVersion) ? context.electronVersion : "unknown" },
    },
    exception: { values: [exception] },
    breadcrumbs: cleanBreadcrumbs(context.breadcrumbs),
    ...(frames.length === 0 ? { fingerprint: [signature] } : {}),
    ...(images.length ? { debug_meta: { images } } : {}),
  };
  return { event, signature };
}

/** One `event` item and nothing else: no attachment, no minidump, no DSN. */
export function buildEnvelope(event, sentAt) {
  const body = JSON.stringify(event);
  return [
    JSON.stringify({ event_id: event.event_id, sent_at: sentAt }),
    JSON.stringify({ type: "event", length: Buffer.byteLength(body) }),
    body,
  ].join("\n") + "\n";
}
