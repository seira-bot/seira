import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FOLDER_NOT_OPEN, FOLDER_READ_ONLY, hostFileGate, hostFileRefusal } from "./host-file-gate.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "folder-gate-")));
const own = join(base, "own");
const reading = join(base, "reading");
const nested = join(reading, "nested");
const writing = join(base, "writing");
const outside = join(base, "outside");
for (const dir of [own, nested, writing, outside]) mkdirSync(dir, { recursive: true });
writeFileSync(join(outside, "secret.txt"), "x");
symlinkSync(outside, join(writing, "escape"));

const grants = [{ path: reading, write: false }, { path: nested, write: true }, { path: writing, write: true }];
const ask = (tool: string, path: string | undefined, folders: Parameters<typeof hostFileRefusal>[0]["folders"]) =>
  hostFileRefusal({ folders, ownRoots: [own], home: base, query: new URLSearchParams({ files: "1", tool, ...(path === undefined ? {} : { path }) }) });

describe("host file gate", () => {
  it("changes nothing without a folder setting", async () => {
    for (const tool of ["list_files", "read_file", "write_file", "make_folder"]) expect(await ask(tool, join(outside, "a"), null)).toBeNull();
    expect(await hostFileGate({ folders: null, ownRoots: [], query: new URLSearchParams({ files: "1" }) })).toBeNull();
  });

  it("allows the working folder and every grant when limited", async () => {
    const folders = { limited: true, grants };
    for (const path of [join(own, "a.txt"), join(reading, "a.txt"), join(writing, "new", "a.txt")]) expect(await ask("read_file", path, folders)).toBeNull();
    expect(await ask("write_file", join(own, "a.txt"), folders)).toBeNull();
    expect(await ask("write_file", join(writing, "deep", "a.txt"), folders)).toBeNull();
  });

  it("refuses a path outside the working folder and the grants when limited", async () => {
    const folders = { limited: true, grants };
    expect(await ask("read_file", join(outside, "secret.txt"), folders)).toBe(FOLDER_NOT_OPEN);
    expect(await ask("write_file", join(base, "elsewhere.txt"), folders)).toBe(FOLDER_NOT_OPEN);
    expect(await ask("list_files", undefined, folders)).toBe(FOLDER_NOT_OPEN);
    expect(await ask("read_file", join(reading, "..", "outside", "secret.txt"), folders)).toBe(FOLDER_NOT_OPEN);
    expect(await ask("read_file", join(base, "readingother", "a"), folders)).toBe(FOLDER_NOT_OPEN);
    expect(await hostFileGate({ folders, ownRoots: [own], query: new URLSearchParams({ files: "1" }) })).toMatchObject({ held: true, blockedReason: FOLDER_NOT_OPEN });
  });

  it("allows a path outside every folder when not limited", async () => {
    expect(await ask("write_file", join(outside, "a.txt"), { limited: false, grants })).toBeNull();
  });

  it("refuses a change inside a read-only grant but allows reading it", async () => {
    for (const limited of [true, false]) {
      const folders = { limited, grants };
      expect(await ask("write_file", join(reading, "a.txt"), folders)).toBe(FOLDER_READ_ONLY);
      expect(await ask("make_folder", join(reading, "new"), folders)).toBe(FOLDER_READ_ONLY);
      expect(await ask("read_file", join(reading, "a.txt"), folders)).toBeNull();
      expect(await ask("list_files", reading, folders)).toBeNull();
    }
  });

  it("lets the deepest grant decide when grants nest", async () => {
    expect(await ask("write_file", join(nested, "a.txt"), { limited: true, grants })).toBeNull();
    const reverse = [{ path: reading, write: true }, { path: nested, write: false }];
    expect(await ask("write_file", join(reading, "a.txt"), { limited: true, grants: reverse })).toBeNull();
    expect(await ask("write_file", join(nested, "a.txt"), { limited: true, grants: reverse })).toBe(FOLDER_READ_ONLY);
  });

  it("keeps the working folder writable inside a read-only grant that holds it", async () => {
    const folders = { limited: true, grants: [{ path: base, write: false }] };
    expect(await ask("write_file", join(own, "a.txt"), folders)).toBeNull();
    expect(await ask("write_file", join(outside, "a.txt"), folders)).toBe(FOLDER_READ_ONLY);
  });

  it("follows a link out of a granted folder before it decides", async () => {
    const limited = { limited: true, grants };
    expect(await ask("read_file", join(writing, "escape", "secret.txt"), limited)).toBe(FOLDER_NOT_OPEN);
    expect(await ask("write_file", join(writing, "escape", "new.txt"), limited)).toBe(FOLDER_NOT_OPEN);
    expect(await ask("read_file", join(writing, "escape", "secret.txt"), { limited: false, grants })).toBeNull();
  });

  it("refuses a call that does not say which tool it is when limited", async () => {
    const query = new URLSearchParams({ files: "1" });
    expect(await hostFileRefusal({ folders: { limited: true, grants }, ownRoots: [own], query })).toBe(FOLDER_NOT_OPEN);
    expect(await hostFileRefusal({ folders: { limited: false, grants }, ownRoots: [own], query })).toBeNull();
  });

  it("refuses a call whose path was not usable, for every tool", async () => {
    for (const tool of ["list_files", "read_file", "write_file", "make_folder"]) {
      const query = new URLSearchParams({ files: "1", tool, pathInvalid: "1" });
      expect(await hostFileRefusal({ folders: { limited: true, grants }, ownRoots: [own], query }), tool).toBe(FOLDER_NOT_OPEN);
    }
  });

  it("checks the home folder only for a listing with no path", async () => {
    const folders = { limited: true, grants };
    expect(await ask("list_files", undefined, folders)).toBe(FOLDER_NOT_OPEN);
    expect(await ask("read_file", undefined, folders)).toBeNull();
  });

  it("leaves a relative path to the file tool, which refuses it", async () => {
    expect(await ask("read_file", "notes.txt", { limited: true, grants })).toBeNull();
  });
});
