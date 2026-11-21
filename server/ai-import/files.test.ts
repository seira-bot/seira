import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { folderFiles } from "./files.ts";
import { READERS } from "./readers.ts";
import { removeTempDir } from "../testing/cleanup.ts";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "seira-ai-import-files-"));
});
afterEach(() => removeTempDir(scratch));

describe("folderFiles", () => {
  it("lists regular files with / names, sorted, and leaves symlinks out", async () => {
    mkdirSync(join(scratch, "memories"));
    writeFileSync(join(scratch, "SOUL.md"), "be kind");
    writeFileSync(join(scratch, "memories", "USER.md"), "likes tea");
    symlinkSync(join(scratch, "SOUL.md"), join(scratch, "link.md"));
    const files = await folderFiles(scratch);
    expect(files.entries).toEqual([{ name: "SOUL.md", size: 7 }, { name: "memories/USER.md", size: 9 }]);
    expect(await text(await files.open("memories/USER.md"))).toBe("likes tea");
  });

  it("refuses a name it did not list", async () => {
    writeFileSync(join(scratch, "a.json"), "{}");
    const files = await folderFiles(scratch);
    await expect(files.open("../a.json")).rejects.toThrow();
  });
});

describe("READERS", () => {
  it("has one reader for each source kind", () => {
    const kinds = READERS.map((reader) => reader.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds.sort()).toEqual(["chatgpt", "claude-ai", "claude-code", "hermes", "openclaw"]);
  });
});
