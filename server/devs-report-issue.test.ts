import { describe, expect, it } from "vitest";

import { isBugReportIssueUrl } from "../shared/devs-report-issue.ts";
import { buildDevsReport, type DevsReportPayload } from "./devs-report.ts";
import { bugReportIssueUrl, bugReportTitle, conversationDiagnostics, MAX_ISSUE_URL, withFinalTitle } from "./devs-report-issue.ts";

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
    expect(query.get("logs")).toBe("Seira @devs report\nApp version: 0.1.128");
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
    expect(query.get("title")).toBe("It broke in and and");
    expect(query.get("logs")).toBe("a ~/x\nb ~\\AppData\nc ~/AppData\nd ~\ne /srv/boxes/y");
  });

  it("titles the issue from the person's first words, at most 80 characters", () => {
    expect(fields(bugReportIssueUrl({ ...PAYLOAD, description: `${"a".repeat(120)}\nmore` })).get("title")).toBe(`${"a".repeat(79)}…`);
    for (const description of ["(no words besides @devs)\n\nWhat they wrote: @devs", "", "  \n\n"]) {
      expect(fields(bugReportIssueUrl({ ...PAYLOAD, description })).get("title"), description).toBe("Bug report from Seira");
    }
  });

  it("takes the payload's own title as it is: one final title for the form and for the relay", () => {
    const own = { ...PAYLOAD, title: "Pictures never load" };
    expect(bugReportTitle(own)).toBe("Pictures never load");
    expect(fields(bugReportIssueUrl(own)).get("title")).toBe("Pictures never load");
    expect(withFinalTitle(own).title).toBe("Pictures never load");
    expect(withFinalTitle(withFinalTitle(PAYLOAD)).title).toBe(withFinalTitle(PAYLOAD).title);
  });

  it("keeps a stored title of up to 120 characters whole, so an error draft shows what the relay files", () => {
    const long = `A request fails: ${"x".repeat(100)}`;
    expect(long.length).toBeLessThanOrEqual(120);
    expect(bugReportTitle({ ...PAYLOAD, title: long })).toBe(long);
    expect(fields(bugReportIssueUrl({ ...PAYLOAD, title: long })).get("title")).toBe(long);
    expect(withFinalTitle(withFinalTitle({ ...PAYLOAD, title: long })).title).toBe(long);
    expect(bugReportTitle({ ...PAYLOAD, title: "y".repeat(150) })).toHaveLength(120);
  });

  it("redacts a title-less payload's first line before the title rules cut into it", () => {
    const key = `sk-ant-${"a".repeat(40)}`;
    expect(bugReportTitle({ ...PAYLOAD, description: `Auth failed with ${key} again` })).toBe("Auth failed with again");
    const piece = "Zq9xK2mP.rTzwab9";
    const title = bugReportTitle({ ...PAYLOAD, description: `The key ${piece} was refused` });
    expect(title).not.toMatch(/Zq9|rTzwab|wab9/);
  });

  it("cleans the description's first line for a report that has no title, and never leaves the title empty", () => {
    const unsafe: Array<[string, string]> = [["It broke in C:\\Users\\ada\\work", "It broke in"], ["It broke on \\\\fileserver\\share\\a.docx", "It broke on"],
      ["It broke at [2001:db8::1]:8080", "It broke at"], ["It broke at localhost:3000", "It broke at"], ["It broke on laptop-ada:8443", "It broke on"]];
    for (const [description, title] of unsafe) expect(bugReportTitle({ ...PAYLOAD, description }), description).toBe(title);
    for (const description of ["C:\\Users\\ada\\work", "https://example.com/a", "ada@example.com", "\\\\fileserver\\share"]) {
      expect(bugReportTitle({ ...PAYLOAD, description }), description).toBe("Bug report from Seira");
    }
    expect(bugReportTitle({ ...PAYLOAD, title: "   " })).toBe("The calendar never syncs");
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

describe("what of the diagnostics goes into a public issue", () => {
  const built = () => buildDevsReport({
    installId: INSTALL, appVersion: "0.1.128", platform: "linux x64, team cloud", os: "linux 6.1 x64", runsOn: "team cloud", node: "v24.0.0", uptimeSeconds: 90, now: Date.UTC(2026, 10, 19),
    threadId: "t1", messageId: "m1", where: "a chat with Scout", message: "@devs it broke", words: "it broke", bots: [],
    problems: ["2026-11-19T08:00:00.000Z tool Bash failed: convert: command not found"],
    performance: ["## Performance", "turn t1 took 4200 ms"],
    cloudComputers: ["computer cc-9f3a opened 3 times"],
    log: ["2026-11-19T08:59:00.000Z warn teammate Grace opened /srv/private/plan.md"],
  }, []);

  it("keeps the conversation's problems and drops the server-wide sections", () => {
    const logs = fields(bugReportIssueUrl(built())).get("logs")!;
    expect(logs).toContain("## Recent problems in this conversation, newest last");
    expect(logs).toContain("tool Bash failed: convert: command not found");
    expect(logs).not.toContain("teammate Grace");
    expect(logs).not.toContain("Server warnings and errors");
    expect(logs).not.toContain("cc-9f3a");
    expect(logs).not.toContain("Cloud computers");
    expect(logs).not.toContain("turn t1 took 4200 ms");
    expect(logs).not.toContain("Performance");
    expect(logs).not.toContain("Install:");
  });

  it("cuts before the first server-wide section when the problems header is missing", () => {
    const diagnostics = "Seira @devs report\nApp version: 1\n\n## Conversation\nMessage: m1\n\n## Cloud computers since the server started\ncomputer x\n\n## Server warnings and errors, newest last\nsecret line";
    expect(conversationDiagnostics(diagnostics)).toBe("Seira @devs report\nApp version: 1\n\n## Conversation\nMessage: m1\n");
    const other = "Seira @devs report\n\n## Server warnings and errors, newest last\nsecret line\n\n## Cloud computers since the server started\nx";
    expect(conversationDiagnostics(other)).toBe("Seira @devs report\n");
  });
});
