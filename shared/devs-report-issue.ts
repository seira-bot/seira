export const BUG_REPORT_ISSUE_FORM = "https://github.com/seira-bot/seira/issues/new";
export const BUG_REPORT_ISSUE_MAX_URL = 8_000;

export function isBugReportIssueUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > BUG_REPORT_ISSUE_MAX_URL) return false;
  try {
    const url = new URL(value);
    return url.origin === "https://github.com" && url.pathname === "/seira-bot/seira/issues/new" && url.searchParams.get("template") === "bug_report.yml";
  } catch {
    return false;
  }
}
