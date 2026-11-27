import { homedir } from "node:os";

import { BUG_REPORT_ISSUE_FORM, BUG_REPORT_ISSUE_MAX_URL } from "../shared/devs-report-issue.ts";
import { GENERIC_REPORT_TITLE, cleanTitle, redactReportText, type DevsReportPayload } from "./devs-report.ts";

export const MAX_ISSUE_URL = BUG_REPORT_ISSUE_MAX_URL;
/** A stored title (a @devs title is cut at 80, an error title at 120) is kept whole, so a second pass changes nothing. */
const TITLE_MAX = 120;
const FALLBACK_TITLE_MAX = 80;
const NO_WORDS = "(no words besides @devs)";
const CUT = "\n…";

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function tidy(text: string, own: readonly string[], home: string): string {
  let out = text;
  for (const value of own) if (value) out = out.split(value).join("");
  if (home.length > 1) out = out.replace(new RegExp(`${escapeRegExp(home.replace(/[\\/]+$/, ""))}(?=$|[\\\\/\\s"'\`),:;])`, "g"), "~");
  return out
    .replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`)]+/g, "~")
    .replace(/\/(?:home|Users)\/[^/\s"'`)]+/g, "~");
}

const PROBLEMS_HEADER = "## Recent problems in this conversation, newest last";
const BROAD_HEADERS = /^## (?:Server warnings and errors|Cloud computers|Performance)/;

/** Only this conversation's part of the diagnostics: the lines before the server-wide sections. */
export function conversationDiagnostics(diagnostics: string): string {
  const lines = diagnostics.split("\n");
  const header = lines.indexOf(PROBLEMS_HEADER);
  if (header >= 0) {
    const blank = lines.findIndex((line, index) => index > header && line.trim() === "");
    return lines.slice(0, blank < 0 ? lines.length : blank).join("\n");
  }
  const broad = lines.findIndex((line) => BROAD_HEADERS.test(line));
  return lines.slice(0, broad < 0 ? lines.length : broad).join("\n");
}

function clipText(text: string, length: number): string {
  const end = text.charCodeAt(length - 1) >= 0xd800 && text.charCodeAt(length - 1) <= 0xdbff ? length - 1 : length;
  return text.slice(0, Math.max(0, end));
}

/** The largest n in [0, size] for which `fits(n)` holds, when `fits` holds for 0 and never turns true again after false. */
function largest(size: number, fits: (n: number) => boolean): number {
  let low = 0, high = size;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid; else high = mid - 1;
  }
  return low;
}

/** The issue's title, one value for the draft, the relay and the issue form: the report's own, else the description's
 * first line cleaned as the title rules say, else a fixed one. The relay never gets to pick a title from the description. */
export function bugReportTitle(payload: DevsReportPayload, home = homedir()): string {
  const own = [payload.installId, payload.contactEmail, payload.contact].filter((value): value is string => Boolean(value));
  const named = payload.title ? tidy(payload.title, own, home).replace(/\s+/g, " ").trim() : "";
  if (named) return clipText(named, TITLE_MAX).trimEnd();
  const words = payload.description.trim().split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  // A payload without a title (an older version made it): secrets go out first, then the title rules clean the first line.
  const clean = words === NO_WORDS ? "" : cleanTitle(words, { redact: (text) => redactReportText(text), names: [...own, ...(home.length > 1 ? [home.replace(/[\\/]+$/, "")] : [])], max: FALLBACK_TITLE_MAX });
  return clean || GENERIC_REPORT_TITLE;
}

/** The payload with its final title stored in it, so what the relay files is what the person saw. */
export const withFinalTitle = (payload: DevsReportPayload, home = homedir()): DevsReportPayload => ({ ...payload, title: bugReportTitle(payload, home) });

export function bugReportIssueUrl(payload: DevsReportPayload, home = homedir()): string {
  const own = [payload.installId, payload.contactEmail, payload.contact].filter((value): value is string => Boolean(value));
  const clean = (text: string) => tidy(text, own, home);
  const diagnostics = clean(conversationDiagnostics(payload.diagnostics).split("\n").filter((line) => !/^\s*Install:\s/.test(line)).join("\n")).trimEnd();
  const description = clean(payload.description).trim();
  const title = bugReportTitle(payload, home);
  const version = clipText(clean(`${payload.appVersion} · ${payload.platform}`).replace(/\s+/g, " ").trim(), 200);

  const build = (what: string, logs: string) => {
    const query = new URLSearchParams({ template: "bug_report.yml", title, "what-happened": what, version });
    if (logs) query.set("logs", logs);
    return `${BUG_REPORT_ISSUE_FORM}?${query.toString()}`;
  };

  let what = description;
  if (build(what, "").length > MAX_ISSUE_URL) {
    const keep = largest(description.length, (n) => build(`${clipText(description, n)}…`, "").length <= MAX_ISSUE_URL);
    what = `${clipText(description, Math.max(1, keep))}…`;
  }
  if (build(what, diagnostics).length <= MAX_ISSUE_URL) return build(what, diagnostics);

  const cutAt = (n: number) => {
    const end = diagnostics.lastIndexOf("\n", n);
    return `${clipText(diagnostics, end > 0 ? end : n)}${CUT}`;
  };
  const kept = largest(diagnostics.length, (n) => n === 0 || build(what, cutAt(n)).length <= MAX_ISSUE_URL);
  return build(what, kept > 0 ? cutAt(kept) : "");
}
