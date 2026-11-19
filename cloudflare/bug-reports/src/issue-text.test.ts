import { describe, expect, it } from "vitest";

import { BODY_LIMIT, commentBody, issueBody, issueTitle, type ReportText } from "./issue-text";
import { bodiesOf, bugHarness, validReport } from "./test-harness";

const text = (extra: Partial<ReportText> = {}): ReportText => ({
  title: undefined,
  description: "It broke.",
  diagnostics: "some log",
  appVersion: "0.1.172",
  platform: "linux",
  ...extra,
});
const HASH = "0123456789abcdef";

describe("issue text", () => {
  it("builds the issue body", () => {
    expect(issueBody(HASH, text())).toBe(
      [
        "<!-- seira-fp:0123456789abcdef -->",
        "Sent from the Seira app.",
        "",
        "| | |",
        "|---|---|",
        "| App version | `0.1.172` |",
        "| Platform | `linux` |",
        "| Error fingerprint | `0123456789abcdef` |",
        "",
        "### What happened",
        "",
        "```text",
        "It broke.",
        "```",
        "",
        "<details><summary>Diagnostics</summary>",
        "",
        "```text",
        "some log",
        "```",
        "",
        "</details>",
        "",
      ].join("\n"),
    );
  });

  it("builds the comment body", () => {
    const body = commentBody("br_abc", text());
    expect(body.startsWith("<!-- seira-report:br_abc -->\nAnother report of this error.\n\nApp version `0.1.172` · Platform `linux`\n\n### What happened")).toBe(true);
  });

  it("keeps backticks and mentions inside a longer fence", () => {
    const description = "Run ```\nrm -rf\n``` and ping @someone #12 <b>x</b>";
    const body = issueBody(HASH, text({ description }));
    expect(body).toContain(`### What happened\n\n\`\`\`\`text\n${description}\n\`\`\`\`\n`);
    const longRun = text({ diagnostics: "``````` seven" });
    expect(issueBody(HASH, longRun)).toContain("````````text\n``````` seven\n````````\n");
  });

  it("strips backticks, pipes and newlines from the table fields", () => {
    const body = issueBody(HASH, text({ appVersion: "1`|\n.0", platform: "li|nux`" }));
    expect(body).toContain("| App version | `1.0` |");
    expect(body).toContain("| Platform | `linux` |");
  });

  it("keeps the body under the GitHub limit with the largest allowed report", () => {
    const description = "d".repeat(10_000);
    const body = issueBody(HASH, text({ description, diagnostics: "x".repeat(262_144) }));
    expect(body.length).toBeLessThanOrEqual(BODY_LIMIT);
    expect(body).toContain(description);
    expect(body).toContain("\n…\n```");
    expect(commentBody("br_abc", text({ description, diagnostics: "x".repeat(262_144) })).length).toBeLessThanOrEqual(BODY_LIMIT);
  });

  it("clips the description only after the diagnostics are gone", () => {
    const body = issueBody(HASH, text({ description: "d".repeat(70_000), diagnostics: "x".repeat(1000) }));
    expect(body.length).toBeLessThanOrEqual(BODY_LIMIT);
    expect(body).toContain("<details><summary>Diagnostics</summary>");
    expect(body).not.toContain("x".repeat(10));
  });

  it("names the issue", () => {
    expect(issueTitle("  Own\ttitle\u0007 ", "ignored")).toBe("Own title");
    expect(issueTitle("t".repeat(200), "ignored")).toHaveLength(120);
    expect(issueTitle(undefined, "\n\n  First line\nsecond")).toBe("First line");
    expect(issueTitle(undefined, "y".repeat(300))).toHaveLength(100);
    expect(issueTitle(undefined, " \n ")).toBe("Bug report from the Seira app");
  });

  it("sends a body under the limit for a 262,144 character report", async () => {
    const h = bugHarness();
    const response = await h.send(validReport({ diagnostics: `## Recent problems in this conversation, newest last\n${"y".repeat(262_000)}` }));
    expect(response.status).toBe(201);
    const [issue] = [...h.github.issues.values()];
    expect(issue!.body.length).toBeLessThanOrEqual(BODY_LIMIT);
    expect(bodiesOf(h.github.apiCalls()).length).toBeLessThan(70_000);
  });
});
