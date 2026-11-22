// Shapes of what the server and the page send to main. Both are untrusted: main keeps only fields it knows, with a size cap,
// and crash-report-event.mjs then checks each value again.
import { PAGE_NAMES } from "./crash-report-event.mjs";

const MAX_TEXT = 20_000;
const MAX_DEBUG_IDS = 50;
const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;
const SERVER_KINDS = new Set(["server-exit", "server-turn"]);
const RENDERER_KINDS = new Set(["renderer-error", "renderer-rejection", "page-boundary"]);
const small = (value, max) => (typeof value === "string" ? value.slice(0, max) : undefined);

function debugIds(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out = {};
  for (const [file, id] of Object.entries(value).slice(0, MAX_DEBUG_IDS)) {
    if (file.length <= 1024 && typeof id === "string" && id.length <= 64) out[file] = id;
  }
  return out;
}

export const pageName = (value) => (PAGE_NAMES.includes(value) ? value : "other");
export const validRequestId = (value) => typeof value === "string" && REQUEST_ID.test(value);

/** K1: a report from the server process, or null. The process type is always "server". */
export function fromServerReport(raw) {
  if (!raw || typeof raw !== "object" || !SERVER_KINDS.has(raw.kind)) return null;
  return {
    kind: raw.kind,
    process: "server",
    errorName: small(raw.errorName, 100),
    errorCode: small(raw.errorCode, 64),
    message: small(raw.message, MAX_TEXT),
    stack: small(raw.stack, MAX_TEXT),
    engine: small(raw.engine, 64),
    debugIds: debugIds(raw.debugIds),
  };
}

/** K2: a report from the page, or null. The process type is always "renderer". */
export function fromRendererReport(raw) {
  if (!raw || typeof raw !== "object" || !RENDERER_KINDS.has(raw.kind)) return null;
  return {
    kind: raw.kind,
    process: "renderer",
    errorName: small(raw.errorName, 100),
    message: small(raw.message, MAX_TEXT),
    stack: small(raw.stack, MAX_TEXT),
    page: pageName(raw.page),
    debugIds: debugIds(raw.debugIds),
  };
}
