import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { effectiveFolderAccess, insideFolder, MAX_FOLDERS, resolveGrantsForTurn, validateFolderAccess } from "./folder-access.ts";

let root = "";
let dataDir = "";
let home = "";
const opts = () => ({ dataDir, home });
const access = (...paths: string[]) => ({ limited: true, folders: paths.map(path => ({ path, write: false })) });

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "folder-access-")));
  dataDir = join(root, "data");
  home = join(root, "home");
  for (const folder of [dataDir, home, join(root, "a"), join(root, "b")]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(root, "file.txt"), "x");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("validateFolderAccess", () => {
  it("accepts a real folder and keeps its flags", () => {
    const result = validateFolderAccess({ limited: false, folders: [{ path: join(root, "a"), write: true }] }, opts());
    expect(result).toEqual({ ok: true, value: { limited: false, folders: [{ path: join(root, "a"), write: true }] } });
  });

  it("refuses a bad shape as invalid", () => {
    for (const input of [null, "x", { limited: true }, { limited: true, folders: [{ path: "" , write: true }] }, { limited: true, folders: [], extra: 1 }]) {
      const result = validateFolderAccess(input, opts());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result).toMatchObject({ refusal: "invalid", message: "That folder list is not valid." });
    }
  });

  it("refuses a relative path", () => {
    expect(validateFolderAccess(access("a/b"), opts())).toMatchObject({ ok: false, refusal: "relative", message: "Use the full path of the folder.", path: "a/b" });
  });

  it("expands a leading tilde with the given home", () => {
    expect(validateFolderAccess(access("~"), opts())).toMatchObject({ ok: true, value: { folders: [{ path: home }] } });
    mkdirSync(join(home, "work"), { recursive: true });
    expect(validateFolderAccess(access("~/work"), opts())).toMatchObject({ ok: true, value: { folders: [{ path: join(home, "work") }] } });
  });

  it("refuses a missing path", () => {
    expect(validateFolderAccess(access(join(root, "nope")), opts())).toMatchObject({ ok: false, refusal: "missing", message: "That folder isn't on this computer." });
  });

  it("refuses a file", () => {
    expect(validateFolderAccess(access(join(root, "file.txt")), opts())).toMatchObject({ ok: false, refusal: "notFolder", message: "That is a file, not a folder." });
  });

  it("refuses the file-system root and system folders", () => {
    for (const path of ["/", "/etc", "/usr/bin"]) {
      expect(validateFolderAccess(access(path), { ...opts(), platform: "linux" }), path).toMatchObject({ ok: false, refusal: "system", message: "Choose one of your own folders, not a system folder." });
    }
  });

  it("refuses the data folder, a folder inside it, and a folder holding it", () => {
    mkdirSync(join(dataDir, "inner"), { recursive: true });
    for (const path of [dataDir, join(dataDir, "inner"), root]) {
      expect(validateFolderAccess(access(path), opts()), path).toMatchObject({ ok: false, refusal: "dataFolder", message: "Seira keeps its own data there. Choose another folder." });
    }
  });

  it("refuses a symlink that leads into the data folder", () => {
    const link = join(root, "to-data");
    symlinkSync(dataDir, link);
    expect(validateFolderAccess(access(link), opts())).toMatchObject({ ok: false, refusal: "dataFolder" });
  });

  it("refuses more than 20 folders", () => {
    const folders = Array.from({ length: MAX_FOLDERS + 1 }, () => ({ path: join(root, "a"), write: false }));
    expect(validateFolderAccess({ limited: true, folders }, opts())).toMatchObject({ ok: false, refusal: "tooMany", message: "You can add up to 20 folders." });
  });

  it("stores the real path for a symlinked input", () => {
    const link = join(root, "link-a");
    symlinkSync(join(root, "a"), link);
    expect(validateFolderAccess(access(link), opts())).toMatchObject({ ok: true, value: { folders: [{ path: join(root, "a") }] } });
  });

  it("deduplicates by real path and the later entry wins", () => {
    const link = join(root, "link-a2");
    symlinkSync(join(root, "a"), link);
    const result = validateFolderAccess({ limited: true, folders: [{ path: join(root, "a"), write: false }, { path: join(root, "b"), write: false }, { path: link, write: true }] }, opts());
    expect(result).toEqual({ ok: true, value: { limited: true, folders: [{ path: join(root, "b"), write: false }, { path: join(root, "a"), write: true }] } });
  });
});

describe("effectiveFolderAccess", () => {
  it("is not limited with no setting", () => {
    expect(effectiveFolderAccess(undefined, null)).toEqual({ limited: false, limitedBy: null, department: null, folders: [] });
  });

  it("lists department folders then bot folders", () => {
    const result = effectiveFolderAccess({ limited: false, folders: [{ path: "/b", write: true }] }, { name: "Sales", access: { limited: false, folders: [{ path: "/a", write: false }] } });
    expect(result.folders).toEqual([{ path: "/a", write: false, from: "department" }, { path: "/b", write: true, from: "bot" }]);
    expect(result.department).toBe("Sales");
  });

  it("lets a bot entry replace the department entry for the same path", () => {
    const result = effectiveFolderAccess({ limited: false, folders: [{ path: "/a", write: true }] }, { name: "Sales", access: { limited: false, folders: [{ path: "/a", write: false }, { path: "/c", write: false }] } });
    expect(result.folders).toEqual([{ path: "/c", write: false, from: "department" }, { path: "/a", write: true, from: "bot" }]);
  });

  it("names who limits: department first, then bot", () => {
    const limited = { limited: true, folders: [] };
    const open = { limited: false, folders: [] };
    expect(effectiveFolderAccess(limited, { name: "S", access: limited })).toMatchObject({ limited: true, limitedBy: "department" });
    expect(effectiveFolderAccess(limited, { name: "S", access: open })).toMatchObject({ limited: true, limitedBy: "bot" });
    expect(effectiveFolderAccess(open, { name: "S", access: limited })).toMatchObject({ limited: true, limitedBy: "department" });
    expect(effectiveFolderAccess(open, { name: "S", access: undefined })).toMatchObject({ limited: false, limitedBy: null });
  });
});

describe("resolveGrantsForTurn", () => {
  it("returns null when not limited and no grants", () => {
    expect(resolveGrantsForTurn(effectiveFolderAccess(undefined, null), { dataDir })).toBeNull();
    expect(resolveGrantsForTurn(effectiveFolderAccess({ limited: false, folders: [] }, null), { dataDir })).toBeNull();
  });

  it("keeps a valid grant", () => {
    const effective = effectiveFolderAccess({ limited: true, folders: [{ path: join(root, "a"), write: true }] }, null);
    expect(resolveGrantsForTurn(effective, { dataDir })).toEqual({ limited: true, grants: [{ path: join(root, "a"), write: true }] });
  });

  it("leaves out a folder that was swapped for a symlink to another folder, and logs it", () => {
    const swapped = join(root, "swap");
    mkdirSync(swapped);
    const effective = effectiveFolderAccess({ limited: true, folders: [{ path: swapped, write: true }] }, null);
    rmSync(swapped, { recursive: true });
    symlinkSync(join(root, "b"), swapped);
    const lines: string[] = [];
    expect(resolveGrantsForTurn(effective, { dataDir, log: line => lines.push(line) })).toEqual({ limited: true, grants: [] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(swapped);
  });

  it("leaves out a folder that is gone", () => {
    const gone = join(root, "gone");
    mkdirSync(gone);
    const effective = effectiveFolderAccess({ limited: false, folders: [{ path: gone, write: false }] }, null);
    rmSync(gone, { recursive: true });
    const lines: string[] = [];
    expect(resolveGrantsForTurn(effective, { dataDir, log: line => lines.push(line) })).toBeNull();
    expect(lines).toHaveLength(1);
  });

  it("leaves out a folder that now overlaps the data folder", () => {
    const effective = effectiveFolderAccess({ limited: true, folders: [{ path: root, write: false }] }, null);
    expect(resolveGrantsForTurn(effective, { dataDir })).toEqual({ limited: true, grants: [] });
  });
});

describe("insideFolder", () => {
  it("counts equal and nested paths, not a sibling that shares a prefix", () => {
    expect(insideFolder("/a/b", "/a/b")).toBe(true);
    expect(insideFolder("/a/b/c", "/a/b")).toBe(true);
    expect(insideFolder("/a/bc", "/a/b")).toBe(false);
    expect(insideFolder("/a", "/a/b")).toBe(false);
  });
});
