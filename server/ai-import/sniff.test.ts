import { describe, expect, it } from "vitest";

import type { ImportSourceKind } from "../../shared/ai-import/bundle.ts";
import type { ImportFiles, SourceReader } from "./reader.ts";
import { sniffSource } from "./sniff.ts";

const files: ImportFiles = { entries: [], open: async () => { throw new Error("not used"); } };

function reader(kind: ImportSourceKind, answer: () => Promise<boolean>): SourceReader {
  return { kind, sniff: answer, read: () => { throw new Error("not used"); } };
}

const after = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

describe("sniffSource", () => {
  it("first match in list order wins", async () => {
    const slow = reader("chatgpt", () => after(150, true));
    const fast = reader("claude-ai", () => after(0, true));
    expect(await sniffSource(files, [slow, fast], 2000)).toBe(slow);
  });

  it("skips a reader that says no", async () => {
    const no = reader("chatgpt", async () => false);
    const yes = reader("claude-ai", () => after(20, true));
    expect(await sniffSource(files, [no, yes], 2000)).toBe(yes);
  });

  it("treats a reader that throws as no", async () => {
    const broken = reader("chatgpt", async () => { throw new Error("boom"); });
    const yes = reader("hermes", async () => true);
    expect(await sniffSource(files, [broken, yes], 2000)).toBe(yes);
    expect(await sniffSource(files, [broken], 2000)).toBeNull();
  });

  it("returns null when every reader says no", async () => {
    expect(await sniffSource(files, [reader("chatgpt", async () => false), reader("hermes", async () => false)], 2000)).toBeNull();
  });

  it("returns null at the time limit when nobody says yes", async () => {
    const never = reader("chatgpt", () => new Promise<boolean>(() => undefined));
    const started = Date.now();
    expect(await sniffSource(files, [never, reader("hermes", async () => false)], 60)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("returns a yes that came before the time limit", async () => {
    const never = reader("chatgpt", () => new Promise<boolean>(() => undefined));
    const yes = reader("hermes", async () => true);
    expect(await sniffSource(files, [never, yes], 60)).toBe(yes);
  });
});
