import { describe, expect, it } from "vitest";

import { fingerprintOf, normalize } from "./fingerprint";

const diagnostics = (time: string, tool: string, line: number, id: string) =>
  [
    "## Recent problems in this conversation, newest last",
    `${time} tool Read failed: ENOENT: no such file`,
    `${time} tool ${tool} failed: TypeError: cannot read x of ${id}`,
    "",
    "## Server warnings and errors, newest last",
    `${time} warn slow turn at 10:00:00`,
    `${time} error TypeError: cannot read x of ${id} at run (/srv/app/server/run-AbC123xy.js:${line}:5) at next (/srv/app/server/next.js:3:1)`,
    `${time} warn engine restarted at 10:00:01`,
  ].join("\n");

describe("fingerprint speed", () => {
  it("reads a 200,000 character line of dots in under 200 ms", async () => {
    const line = "a.".repeat(100_000);
    const diagnostics = [
      "## Recent problems in this conversation, newest last",
      `2026-11-19T10:00:00.000Z tool Bash failed: ${line}`,
      "",
      "## Server warnings and errors, newest last",
      line,
    ].join("\n");
    const start = performance.now();
    await fingerprintOf({ description: "x", diagnostics });
    await fingerprintOf({ description: "x", diagnostics: line });
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe("fingerprint", () => {
  it("is the same for the same error at another time, line and id", async () => {
    const a = await fingerprintOf({ description: "one", diagnostics: diagnostics("2026-11-19T10:00:00.000Z", "Bash", 12, "42") });
    const b = await fingerprintOf({ description: "two", diagnostics: diagnostics("2026-11-20T08:30:00.000Z", "Bash", 99, "7") });
    expect(a.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(b.hash).toBe(a.hash);
    expect(a).toMatchObject({ kind: "typeerror", step: "tool:bash", frame: "run run.js" });
  });

  it("differs for another tool", async () => {
    const a = await fingerprintOf({ description: "x", diagnostics: diagnostics("2026-11-19T10:00:00.000Z", "Bash", 12, "42") });
    const b = await fingerprintOf({ description: "x", diagnostics: diagnostics("2026-11-19T10:00:00.000Z", "Edit", 12, "42") });
    expect(b.hash).not.toBe(a.hash);
  });

  it("reads a stack frame on its own line", async () => {
    const result = await fingerprintOf({
      description: "x",
      diagnostics: "## Server warnings and errors, newest last\nTypeError: boom\n    at async load (file:///srv/app/load.mjs:4:9)",
    });
    expect(result.frame).toBe("load load.mjs");
  });

  it("reads a turn failure and an error code", async () => {
    const result = await fingerprintOf({
      description: "x",
      diagnostics: "## Recent problems in this conversation, newest last\n2026-11-19T10:00:00.000Z turn failed: connect ECONNRESET 10.0.0.1:443",
    });
    expect(result).toMatchObject({ step: "turn", kind: "econnreset" });
  });

  it("uses the hint instead of the diagnostics", async () => {
    const plain = await fingerprintOf({ description: "x", diagnostics: diagnostics("2026-11-19T10:00:00.000Z", "Bash", 12, "42") });
    const hinted = await fingerprintOf({
      description: "x",
      diagnostics: diagnostics("2026-11-19T10:00:00.000Z", "Bash", 12, "42"),
      hint: { kind: "TypeError", step: "Tool:Edit 12", frame: "Run.js" },
    });
    expect(hinted).toMatchObject({ kind: "typeerror", step: "tool:edit #", frame: "run.js" });
    expect(hinted.hash).not.toBe(plain.hash);
  });

  it("falls back to the first description line", async () => {
    const a = await fingerprintOf({ description: "\n  The app froze at step 3\nmore", diagnostics: "" });
    const b = await fingerprintOf({ description: "The app froze at step 9", diagnostics: "" });
    expect(a.step).toBe("the app froze at step #");
    expect(b.hash).toBe(a.hash);
  });

  it("normalizes ids, numbers and masks", () => {
    expect(normalize("Job 12 of 3f2a9c1b-0000-4000-8000-123456789abc at «email» deadbeef  x")).toBe("job # of # at # # x");
  });
});
