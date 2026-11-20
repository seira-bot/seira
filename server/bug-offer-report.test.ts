import { describe, expect, it } from "vitest";

import { buildOfferReport, cleanReportText, publicDevsReport, type OfferReportInput } from "./bug-offer-report.ts";

const MESSAGE = "Sinta, please merge sales-report.xlsx with the March numbers and send it to the board before noon.";
const STACK = [
  "TypeError: Cannot read properties of undefined (reading 'rows') in /home/rama/Documents/Klien Sinta/sales-report.xlsx",
  "    at readSheet (/home/rama/.local/share/seira/server/drivers/agents-files.ts:212:17)",
].join("\n");

function input(extra: Partial<OfferReportInput> = {}): OfferReportInput {
  return {
    installId: "4b7c1f2e-0a9d-4c2b-9f1e-6d5a4b3c2d1e", appVersion: "0.1.178", platform: "linux x64, desktop app", os: "linux 6.8.0 x64",
    runsOn: "desktop app", node: "v24.1.0", language: "en",
    error: { text: STACK, tool: "mcp__agents__read_sheet" }, where: "step", recovered: true,
    steps: [{ tool: "Read", ok: true }, { tool: "mcp__agents__read_sheet", ok: false }, { tool: "mcp__github__create_issue", ok: true }],
    engine: { name: "Claude Code", model: "claude-opus-5-5", health: "available, signed in" },
    problems: [`2026-11-19T09:00:00.000Z tool mcp__agents__read_sheet failed: could not read /home/rama/Klien Sinta/sales-report.xlsx for sinta@example.com`],
    log: [`2026-11-19T09:00:01.000Z warn ${MESSAGE}`, "2026-11-19T09:00:02.000Z warn open C:\\Users\\Rama\\Desktop\\budget 2027.docx failed"],
    names: ["Sinta", "Rama Aditya"], messages: [MESSAGE],
    ...extra,
  };
}

describe("the report a bot writes after Seira's own error (AC-03)", () => {
  it("holds no person's name, file name, path, address or message text, in any field", () => {
    const report = buildOfferReport(input());
    const text = JSON.stringify(report.payload);
    for (const part of ["Sinta", "sinta", "Rama", "sales-report", "budget 2027", "/home/rama", "Klien", "C:\\\\Users", "example.com", "March numbers", "merge sales"]) {
      expect(text).not.toContain(part);
    }
    expect(report.payload.diagnostics).toContain("<file>.xlsx");
    expect(report.payload.diagnostics).toContain("«message text»");
    expect(report.payload.diagnostics).toContain("server/drivers/agents-files.ts:212:17");
    expect(report.payload.diagnostics).not.toMatch(/^Install:/m);
    expect(report.payload.contactEmail).toBeUndefined();
  });

  it("is written from fixed sentences: the title and description name the step, never the person's words", () => {
    const report = buildOfferReport(input());
    expect(report.title).toBe("Step read_sheet fails: Cannot read properties of undefined (reading 'rows') in <file>.xlsx");
    expect(report.payload.title).toBe(report.title);
    expect(report.payload.description).toContain("The bot went on and finished the task another way.");
    expect(report.payload.diagnostics).toContain("2. read_sheet · failed");
    expect(report.payload.diagnostics).toContain("3. a connected app's tool · done");
    expect(report.payload.fingerprint).toEqual({ kind: "TypeError: Cannot read properties of undefined (reading 'rows') in <file>.xlsx", step: "read_sheet", frame: "readSheet (server/drivers/agents-files.ts)" });
    expect(report.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(report.model).toBe("claude-opus-5-5");
    expect(report.activity).toBe(3);
  });

  it("gives the same hash for the same fault in another person's conversation", () => {
    const other = buildOfferReport(input({ error: { text: STACK.replaceAll("Klien Sinta", "Client Budi").replaceAll("/home/rama", "/home/budi"), tool: "agents__read_sheet" }, names: ["Budi"], messages: ["Budi here"] }));
    expect(other.hash).toBe(buildOfferReport(input()).hash);
  });

  it("names a failed turn and a failed request in their own words", () => {
    expect(buildOfferReport(input({ error: { text: "TypeError: x is not a function" }, where: "turn" })).title).toBe("A turn stops: x is not a function");
    expect(buildOfferReport(input({ error: { text: "TypeError: x is not a function" }, where: "request", steps: [] })).title).toBe("A request fails: x is not a function");
  });
});

describe("cleaning a line of a report", () => {
  it("keeps Seira's own code in a path and removes the rest", () => {
    expect(cleanReportText("at f (/opt/Seira/resources/app/dist-server/index.js:1:2)")).toBe("at f (dist-server/index.js:1:2)");
    expect(cleanReportText("could not open ~/notes/plan.md and /var/tmp/x")).toBe("could not open <file>.md and <path>");
    expect(cleanReportText("a / b and 1/2")).toBe("a / b and 1/2");
    expect(cleanReportText("open /home/a/Klien Budi/q1 plan.xlsx failed")).toBe("open <file>.xlsx failed");
    expect(cleanReportText("open C:\\Users\\Budi\\Desktop\\budget 2027.docx failed")).toBe("open <file>.docx failed");
  });
});

describe("a @devs report as a public issue (AC-09)", () => {
  it("drops the address and the install line, and cleans paths out of the diagnostics", () => {
    const report = publicDevsReport({ installId: "abc", source: "bot", description: "Pictures never load", appVersion: "0.1.178", platform: "linux",
      diagnostics: "Install: abc\nLog: failed at /home/rama/Pictures/cat.png", contactEmail: "ada@example.com", contact: "ada@example.com" });
    expect(report.contactEmail).toBeUndefined();
    expect(report.contact).toBeUndefined();
    expect(report.diagnostics).toBe("Log: failed at <file>.png");
    expect(report.description).toBe("Pictures never load");
  });
});
