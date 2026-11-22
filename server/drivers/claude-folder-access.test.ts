import { describe, expect, it } from "vitest";

import { claudeFolderArgs, claudeFolderKey, claudeFolderLimitRefusal, claudeFolderPermissions, claudeRulePath } from "./claude-folder-access.ts";

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
    expect(claudeFolderPermissions(undefined, "linux")).toBeNull();
    expect(claudeFolderArgs(undefined)).toEqual([]);
  });

  it("keeps the deny of a read-only grant over a can-change grant inside it", () => {
    const permissions = claudeFolderPermissions({ limited: false, grants }, "linux");
    expect(permissions?.deny).toEqual(["Edit(//data/ro/**)", "Write(//data/ro/**)", "NotebookEdit(//data/ro/**)"]);
    expect(permissions?.additionalDirectories).toEqual(["/data/ro", "/data/ro/inner"]);
  });

  it("sets both limits for a limited turn", () => {
    expect(claudeFolderPermissions({ limited: true, grants: [] }, "linux")).toEqual({
      blockReadsOutsideWorkingDirectories: true, blockWritesOutsideWorkingDirectories: true,
    });
  });
});

describe("claudeFolderLimitRefusal", () => {
  const limited = { limited: true, grants: [] };

  it("refuses a limited turn on a CLI below either floor", () => {
    expect(claudeFolderLimitRefusal(limited, [2, 1, 250])).toMatch(/Update Claude Code/);
    expect(claudeFolderLimitRefusal(limited, [2, 1, 300])).toMatch(/Update Claude Code/);
  });

  it("lets a limited turn run on a new enough or unknown CLI, and a turn that is not limited on any", () => {
    expect(claudeFolderLimitRefusal(limited, [2, 1, 330])).toBeNull();
    expect(claudeFolderLimitRefusal(limited, null)).toBeNull();
    expect(claudeFolderLimitRefusal({ limited: false, grants: [] }, [2, 1, 100])).toBeNull();
    expect(claudeFolderLimitRefusal(undefined, [2, 1, 100])).toBeNull();
  });
});

describe("claudeFolderKey", () => {
  it("changes with a write flag or the limit, not with the order of grants", () => {
    const a = { path: "/a", write: false }, b = { path: "/b", write: true };
    expect(claudeFolderKey({ limited: true, grants: [a, b] })).toBe(claudeFolderKey({ limited: true, grants: [b, a] }));
    expect(claudeFolderKey({ limited: true, grants: [a, b] })).not.toBe(claudeFolderKey({ limited: false, grants: [a, b] }));
    expect(claudeFolderKey({ limited: true, grants: [a, b] })).not.toBe(claudeFolderKey({ limited: true, grants: [{ ...a, write: true }, b] }));
    expect(claudeFolderKey(undefined)).toBeNull();
  });
});
