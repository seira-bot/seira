import { describe, expect, it } from "vitest";

import { claudeFolderArgs, claudeFolderPermissions, claudeRulePath } from "./claude-folder-access.ts";

describe("claudeRulePath", () => {
  it("writes an absolute path with a leading double slash", () => {
    expect(claudeRulePath("/home/me/docs", "linux")).toBe("//home/me/docs");
  });

  it("turns a Windows drive path into a folder under the double slash", () => {
    expect(claudeRulePath("C:\\a\\b", "win32")).toBe("//c/a/b");
  });
});

describe("claudeFolderPermissions", () => {
  const grants = [{ path: "/data/ro", write: false }, { path: "/data/ro/inner", write: true }];

  it("gives nothing for a turn with no folder setting", () => {
    expect(claudeFolderPermissions(undefined, [2, 1, 330], "linux")).toBeNull();
    expect(claudeFolderArgs(undefined)).toEqual([]);
  });

  it("keeps the deny of a read-only grant over a can-change grant inside it", () => {
    const permissions = claudeFolderPermissions({ limited: false, grants }, [2, 1, 330], "linux");
    expect(permissions?.deny).toEqual(["Edit(//data/ro/**)", "Write(//data/ro/**)", "NotebookEdit(//data/ro/**)"]);
    expect(permissions?.additionalDirectories).toEqual(["/data/ro", "/data/ro/inner"]);
  });

  it("treats an unknown CLI version as new enough for the limits", () => {
    expect(claudeFolderPermissions({ limited: true, grants: [] }, null, "linux")).toEqual({
      blockReadsOutsideWorkingDirectories: true, blockWritesOutsideWorkingDirectories: true,
    });
  });

  it("gives no setting for a limited turn on a CLI below both floors", () => {
    expect(claudeFolderPermissions({ limited: true, grants: [] }, [2, 1, 200], "linux")).toBeNull();
  });
});
