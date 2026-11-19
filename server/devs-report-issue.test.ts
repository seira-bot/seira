import { describe, expect, it } from "vitest";

import { isBugReportIssueUrl } from "../shared/devs-report-issue.ts";
import type { DevsReportPayload } from "./devs-report.ts";
import { bugReportIssueUrl, MAX_ISSUE_URL } from "./devs-report-issue.ts";

const INSTALL = "4b7c1f2e-0a9d-4c2b-9f1e-6d5a4b3c2d1e";
const PAYLOAD: DevsReportPayload = {
  installId: INSTALL, source: "bot", description: "The calendar never syncs\n\nWhat they wrote: @devs the calendar never syncs\nWhere: a chat with Atlas",
  appVersion: "0.1.128", platform: "darwin arm64, desktop app",
  diagnostics: `Seira @devs report\nApp version: 0.1.128\nInstall: ${INSTALL}\n\n## Server warnings and errors, newest last\nfailed to read /srv/box/notes.txt`,
  contactEmail: "ada@example.com", contact: "ada@example.com",
};
const fields = (url: string) => new URL(url).searchParams;

describe("the prefilled issue form for a @devs report", () => {
  it("fills the form fields by id under the Seira bug report form", () => {
    const url = bugReportIssueUrl(PAYLOAD, "/srv/box");
    expect(url.startsWith("https://github.com/seira-bot/seira/issues/new?template=bug_report.yml")).toBe(true);
    expect(isBugReportIssueUrl(url)).toBe(true);
    const query = fields(url);
    expect(query.get("title")).toBe("The calendar never syncs");
    expect(query.get("what-happened")).toBe(PAYLOAD.description);
    expect(query.get("version")).toBe("0.1.128 · darwin arm64, desktop app");
    expect(query.get("logs")).toContain("## Server warnings and errors, newest last");
  });

  it("carries no contact address and no install id", () => {
    const url = bugReportIssueUrl({ ...PAYLOAD, description: `${PAYLOAD.description}\nwrite to ada@example.com or ${INSTALL}` });
    const text = decodeURIComponent(url.replace(/\+/g, " "));
    expect(text).not.toContain("ada@example.com");
    expect(text).not.toContain(INSTALL);
    expect(text).not.toMatch(/Install:/);
    expect(text).not.toMatch(/contact/i);
  });

  it("shows home folders as ~", () => {
    const home = "/srv/box";
    const url = bugReportIssueUrl({
      ...PAYLOAD,
      description: "It broke in /srv/box/work and /home/ada/work and /Users/ada/work",
      diagnostics: "a /srv/box/x\nb C:\\Users\\Ada\\AppData\nc C:/Users/Ada/AppData\nd /home/ada\ne /srv/boxes/y",
    }, home);
    const query = fields(url);
    expect(query.get("what-happened")).toBe("It broke in ~/work and ~/work and ~/work");
    expect(query.get("title")).toBe("It broke in ~/work and ~/work and ~/work");
    expect(query.get("logs")).toBe("a ~/x\nb ~\\AppData\nc ~/AppData\nd ~\ne /srv/boxes/y");
  });

  it("titles the issue from the person's first words, at most 80 characters", () => {
    expect(fields(bugReportIssueUrl({ ...PAYLOAD, description: `${"a".repeat(120)}\nmore` })).get("title")).toBe("a".repeat(80));
    for (const description of ["(no words besides @devs)\n\nWhat they wrote: @devs", "", "  \n\n"]) {
      expect(fields(bugReportIssueUrl({ ...PAYLOAD, description })).get("title"), description).toBe("Bug report from Seira");
    }
  });

  it("keeps the whole address within the limit and cuts the logs at a line end", () => {
    const diagnostics = Array.from({ length: 2_000 }, (_, i) => `line ${i} ${"é".repeat(40)}`).join("\n");
    const url = bugReportIssueUrl({ ...PAYLOAD, diagnostics });
    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL);
    const logs = fields(url).get("logs")!;
    expect(logs.endsWith("\n…")).toBe(true);
    expect(logs.startsWith("line 0 ")).toBe(true);
    for (const line of logs.slice(0, -2).split("\n")) expect(line).toMatch(/^line \d+ é{40}$/);
    expect(fields(url).get("what-happened")).toBe(PAYLOAD.description);
  });

  it("clips a long description to fit and keeps its start", () => {
    const description = `The start of the story\n${"x".repeat(20_000)}`;
    const url = bugReportIssueUrl({ ...PAYLOAD, description });
    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL);
    const what = fields(url).get("what-happened")!;
    expect(what.startsWith("The start of the story\nxxx")).toBe(true);
    expect(what.endsWith("…")).toBe(true);
    expect(fields(url).get("title")).toBe("The start of the story");
    expect(fields(url).has("logs")).toBe(false);
  });

  it("fits a description made of characters that encode to many bytes", () => {
    const url = bugReportIssueUrl({ ...PAYLOAD, description: "日本語".repeat(5_000), diagnostics: "😀".repeat(5_000) });
    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL);
    expect(() => decodeURIComponent(url)).not.toThrow();
  });
});
