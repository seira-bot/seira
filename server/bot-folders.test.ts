import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createBotFolders } from "./bot-folders.ts";
import type { FolderAccess } from "./folder-access.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bot-folders-")));
  roots.push(root);
  const data = join(root, "data"), shared = join(root, "shared"), own = join(root, "own");
  for (const dir of [data, shared, own]) mkdirSync(dir);
  return { data, shared, own };
}

describe("createBotFolders", () => {
  it("gives a bot with no setting in a department with no setting no turn folders", () => {
    const { data } = setup();
    const folders = createBotFolders({ bot: () => ({ section: "Sales" }), departments: { get: () => undefined }, dataDir: data });
    expect(folders.forTurn("b1")).toBeNull();
    expect(folders.effective("b1")).toEqual({ limited: false, limitedBy: null, department: "Sales", folders: [] });
  });

  it("joins the department folders and the bot folders, and the department can limit the bot", () => {
    const { data, shared, own } = setup();
    const department: FolderAccess = { limited: true, folders: [{ path: shared, write: false }] };
    const folders = createBotFolders({
      bot: () => ({ section: " Sales ", folderAccess: { limited: false, folders: [{ path: own, write: true }] } }),
      departments: { get: (section) => section === "Sales" ? department : undefined },
      dataDir: data,
    });
    expect(folders.forTurn("b1")).toEqual({ limited: true, grants: [{ path: shared, write: false }, { path: own, write: true }] });
    expect(folders.effective("b1")?.limitedBy).toBe("department");
  });

  it("does not read department folders for a bot outside any department", () => {
    const { data, shared } = setup();
    const folders = createBotFolders({
      bot: () => ({}),
      departments: { get: () => ({ limited: true, folders: [{ path: shared, write: true }] }) },
      dataDir: data,
    });
    expect(folders.forTurn("b1")).toBeNull();
  });

  it("returns null for an unknown bot", () => {
    const { data } = setup();
    expect(createBotFolders({ bot: () => undefined, departments: { get: () => undefined }, dataDir: data }).forTurn("gone")).toBeNull();
  });
});
