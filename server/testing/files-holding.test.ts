import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { filesHolding } from "./files-holding.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "omb-files-holding-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

// What server/atomic.ts names the file it writes before the rename: <file>.<pid>.<uuid>.tmp
const temporary = (file: string, pid = 4242) => `${file}.${pid}.0a1b2c3d-1111-2222-3333-444455556666.tmp`;

describe("filesHolding", () => {
  it("names the files that hold the text, relative to the folder, sorted", () => {
    mkdirSync(join(root, "deep", "er"), { recursive: true });
    writeFileSync(join(root, "b.json"), "the secret");
    writeFileSync(join(root, "deep", "er", "a.json"), "x the secret y");
    writeFileSync(join(root, "c.json"), "nothing here");
    expect(filesHolding(root, "the secret")).toEqual(["b.json", join("deep", "er", "a.json")]);
  });

  it("leaves out what the caller skips", () => {
    writeFileSync(join(root, "keep.json"), "s3");
    writeFileSync(join(root, "dump.json"), "s3");
    expect(filesHolding(root, "s3", { skip: (_path, name) => name === "dump.json" })).toEqual(["keep.json"]);
  });

  it("counts the temp file of an atomic write as the file it becomes, once", () => {
    writeFileSync(join(root, "mcp-oauth.json"), "s3");
    writeFileSync(join(root, temporary("mcp-oauth.json")), "s3");
    expect(filesHolding(root, "s3")).toEqual(["mcp-oauth.json"]);
    // The write was caught before its rename: the file it was about to become holds the text.
    rmSync(join(root, "mcp-oauth.json"));
    expect(filesHolding(root, "s3")).toEqual(["mcp-oauth.json"]);
  });

  it("does not fail when a file vanishes between the listing and the read", () => {
    // The skip hook runs after the folder was listed and before the file is read, so removing the file there is the
    // race of a server that writes through a temp file and renames it, made certain.
    const names = [temporary("bots.json"), temporary("bots.json", 4243), temporary("bots.json", 4244)];
    for (const name of names) writeFileSync(join(root, name), "other");
    writeFileSync(join(root, "kept.json"), "s3");
    expect(filesHolding(root, "s3", { skip: (path, name) => { if (name.endsWith(".tmp")) rmSync(path); return false; } })).toEqual(["kept.json"]);
  });

  it("does not fail when a folder vanishes between the listing and the walk", () => {
    mkdirSync(join(root, "gone"));
    writeFileSync(join(root, "gone", "inner.json"), "s3");
    writeFileSync(join(root, "kept.json"), "s3");
    expect(filesHolding(root, "s3", { skip: (path, name) => { if (name === "gone") rmSync(path, { recursive: true }); return false; } })).toEqual(["kept.json"]);
  });

  it("names the temp file the same way server/atomic.ts does", () => {
    // indirect: the name is built in one line of atomic.ts; this fails when that line changes, so the pattern is updated with it.
    expect(readFileSync(join(import.meta.dirname, "..", "atomic.ts"), "utf8")).toContain("`${path}.${process.pid}.${randomUUID()}.tmp`");
  });
});
