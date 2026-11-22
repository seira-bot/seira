import { readFileSync } from "node:fs";

const FILE = new URL("./crash-report.json", import.meta.url);
const ENVIRONMENT = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

function parseUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value.trim());
    return url.username || url.password ? null : url;
  } catch {
    return null;
  }
}

/** The build writes the file only when it has an endpoint; any other state keeps crash reporting off. */
function readFileConfig(read) {
  try {
    const raw = JSON.parse(read(FILE, "utf8"));
    const url = parseUrl(raw?.url);
    if (!url || url.protocol !== "https:") return null;
    const environment = typeof raw.environment === "string" && ENVIRONMENT.test(raw.environment) ? raw.environment : "production";
    return { url: url.href, environment };
  } catch {
    return null;
  }
}

/**
 * `{ url, environment }`, or null while crash reporting is off.
 * Security: a packaged app never reads the endpoint from its environment, so a variable set by another program cannot redirect reports.
 */
export function loadCrashReportConfig({ app, env = process.env, read = readFileSync } = {}) {
  if (app?.isPackaged !== true) {
    const url = parseUrl(env.SEIRA_CRASH_REPORT_URL);
    if (url && (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK.has(url.hostname)) {
      return { url: url.href, environment: "development" };
    }
  }
  return readFileConfig(read);
}
