import { describe, expect, it } from "vitest";

import { BUG_REPORT_ISSUE_FORM, BUG_REPORT_ISSUE_MAX_URL, isBugReportIssueUrl } from "./devs-report-issue.ts";

const good = `${BUG_REPORT_ISSUE_FORM}?template=bug_report.yml&title=It+broke`;

describe("the Seira issue form address", () => {
  it("accepts the bug report form under the Seira repository", () => {
    expect(isBugReportIssueUrl(good)).toBe(true);
    expect(isBugReportIssueUrl(`${BUG_REPORT_ISSUE_FORM}?title=x&template=bug_report.yml`)).toBe(true);
  });

  it("refuses every other address and every other value", () => {
    for (const value of [
      "https://evil.example/x", "https://github.com/other/repo/issues/new?template=bug_report.yml",
      "https://github.com/seira-bot/seira/issues/new", "https://github.com/seira-bot/seira/issues/new?template=other.yml",
      "https://github.com/seira-bot/seira/issues/new/extra?template=bug_report.yml", "http://github.com/seira-bot/seira/issues/new?template=bug_report.yml",
      "https://github.com.evil.example/seira-bot/seira/issues/new?template=bug_report.yml", "https://user@github.com/seira-bot/seira/issues/new?template=bug_report.yml@x",
      "javascript:alert(1)", "not an address", "", undefined, null, 5, {},
    ]) expect(isBugReportIssueUrl(value), String(value)).toBe(false);
  });

  it("refuses an address longer than the limit", () => {
    expect(isBugReportIssueUrl(`${good}&logs=${"x".repeat(BUG_REPORT_ISSUE_MAX_URL)}`)).toBe(false);
  });
});
