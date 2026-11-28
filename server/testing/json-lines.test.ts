import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readJsonLines } from "./json-lines.ts";

const fresh = () => join(mkdtempSync(join(tmpdir(), "json-lines-")), "plan.json.evidence.jsonl");

describe("readJsonLines", () => {
  it("leaves out a row whose newline has not landed yet, and reads it once it has", () => {
    const path = fresh();
    const row = JSON.stringify({ botId: "b", prompt: "x".repeat(30_000) });
    writeFileSync(path, `${JSON.stringify({ botId: "a" })}\n${row.slice(0, 22_689)}`);
    expect(readJsonLines(path)).toEqual([{ botId: "a" }]);
    appendFileSync(path, `${row.slice(22_689)}\n`);
    expect(readJsonLines(path).map((turn) => turn.botId)).toEqual(["a", "b"]);
  });

  it("reads no rows from a missing or empty file", () => {
    const path = fresh();
    expect(readJsonLines(path)).toEqual([]);
    writeFileSync(path, "");
    expect(readJsonLines(path)).toEqual([]);
  });
});
