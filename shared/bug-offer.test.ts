import { describe, expect, it } from "vitest";

import { errorFingerprint, errorKind, isSeiraTool, seiraOwnsError, stepName } from "./bug-offer.ts";

const SEIRA_STACK = [
  "TypeError: Cannot read properties of undefined (reading 'rows')",
  "    at readSheet (/home/someone/.local/share/seira/server/drivers/agents-files.ts:212:17)",
  "    at async handle (/home/someone/.local/share/seira/server/host/agents-call.ts:88:5)",
].join("\n");
const LIBRARY_STACK = [
  "TypeError: Cannot read properties of undefined (reading 'x')",
  "    at parse (/app/node_modules/some-lib/index.js:10:3)",
].join("\n");

describe("whether an error is Seira's own (AC-02)", () => {
  it.each([
    ["signed out", "Claude Code is signed out. Sign in again."],
    ["a refused key", "401 Unauthorized: invalid api key"],
    ["a spend limit", "You reached your spend limit for this month."],
    ["a rate limit", "429 Too Many Requests"],
    ["no internet", "fetch failed: ECONNREFUSED"],
    ["a request too large", "The request is too large for the model's context window."],
    ["a broken file", "TypeError: Unexpected end of JSON input while reading report.json"],
    ["a missing file", "ENOENT: no such file or directory"],
  ])("is never Seira's for %s", (_why, text) => {
    expect(seiraOwnsError({ text })).toBe(false);
    expect(seiraOwnsError({ text, tool: "mcp__agents__read_file" })).toBe(false);
  });

  it("is never Seira's for a failed-turn row with a cause the person fixes", () => {
    const text = "TypeError: x is not a function";
    expect(seiraOwnsError({ text, setup: true })).toBe(false);
    expect(seiraOwnsError({ text, claudeUpdate: true })).toBe(false);
    expect(seiraOwnsError({ text, limitResetsAt: Date.UTC(2026, 10, 20) })).toBe(false);
    expect(seiraOwnsError({ text, place: { id: "p" } })).toBe(false);
    expect(seiraOwnsError({ text, nameCode: "server.turn.stopped" })).toBe(false);
  });

  it("is Seira's for a code fault in Seira's own code or with no stack, and for a stall in Seira's own tool", () => {
    expect(seiraOwnsError({ text: SEIRA_STACK })).toBe(true);
    expect(seiraOwnsError({ text: "TypeError: x is not a function" })).toBe(true);
    expect(seiraOwnsError({ text: SEIRA_STACK, tool: "mcp__agents__send_message" })).toBe(true);
    expect(seiraOwnsError({ text: "The tool timed out after 60 s", tool: "agents__browse" })).toBe(true);
  });

  it("is not Seira's for another tool's error, a library's fault, or a stall outside a step", () => {
    expect(seiraOwnsError({ text: SEIRA_STACK, tool: "Bash" })).toBe(false);
    expect(seiraOwnsError({ text: SEIRA_STACK, tool: "mcp__github__create_issue" })).toBe(false);
    expect(seiraOwnsError({ text: LIBRARY_STACK })).toBe(false);
    expect(seiraOwnsError({ text: "The request timed out" })).toBe(false);
    expect(seiraOwnsError({ text: "" })).toBe(false);
  });

  it("knows Seira's own tool as each engine spells it", () => {
    for (const tool of ["mcp__agents__send", "agents__send", "agents_send", "agents.send"]) expect(isSeiraTool(tool)).toBe(true);
    for (const tool of ["Bash", "mcp__github__x", "agentsend"]) expect(isSeiraTool(tool)).toBe(false);
    expect(stepName("mcp__agents__send_message")).toBe("send_message");
    expect(stepName(undefined)).toBe("turn");
  });
});

describe("the error's fingerprint", () => {
  it("is the same for the same fault on two machines, two runs and a new build", () => {
    const other = SEIRA_STACK.replaceAll("/home/someone/.local/share/seira", "C:\\Users\\Other\\AppData\\seira").replace(":212:17", ":230:9");
    const one = errorFingerprint({ text: SEIRA_STACK, tool: "mcp__agents__read_sheet" });
    expect(errorFingerprint({ text: other, tool: "agents__read_sheet" })).toEqual(one);
    expect(one).toEqual({ kind: "TypeError: Cannot read properties of undefined (reading 'rows')", step: "read_sheet", frame: "readSheet (server/drivers/agents-files.ts)" });
  });

  it("holds no path, address, quoted text, id or number", () => {
    const kind = errorKind(`Error: could not open "/home/ada/Q3 sales.xlsx" for ada@example.com, job 4f9a2c1b7e, try 3 at https://example.com/x?y=1`);
    expect(kind).toBe(`Error: could not open "…" for <email>, job <id>, try N at <url>`);
    for (const part of ["ada", "Q3", "sales", "example.com/x", "4f9a2c1b7e", "3"]) expect(kind).not.toContain(part);
  });

  it("keeps each field within the relay's limit", () => {
    const long = `TypeError: ${"x".repeat(500)}\n    at ${"f".repeat(400)} (server/a.ts:1:1)`;
    const print = errorFingerprint({ text: long, tool: `agents__${"s".repeat(400)}` });
    expect(print.kind.length).toBeLessThanOrEqual(200);
    expect(print.step!.length).toBeLessThanOrEqual(200);
    expect(print.frame!.length).toBeLessThanOrEqual(200);
  });
});
