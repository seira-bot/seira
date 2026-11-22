import { describe, expect, it } from "vitest";

import type { ProcessRow } from "./process-buckets.ts";
import { dropStaleParents, parseWindowsProcessLines, WINDOWS_PROCESS_SCRIPT } from "./windows-process-list.ts";

describe("parseWindowsProcessLines", () => {
  it("reads pid, parent, private bytes, CPU time, start and name", () => {
    const rows = parseWindowsProcessLines("0\t0\t0\t0\t0\tSystem Idle Process\r\n4\t0\t200\t50000\t133000000000000000\tSystem\r\n812\t640\t52428800\t123450000\t133000000000000001\tCodex Helper.EXE\r\n");
    expect(rows).toEqual([
      { pid: 4, ppid: 0, name: "system", cpuMs: 5, rssBytes: 200, start: "win:133000000000000000" },
      { pid: 812, ppid: 640, name: "codex helper.exe", cpuMs: 12_345, rssBytes: 52_428_800, start: "win:133000000000000001" },
    ]);
  });

  it("skips lines that are not process rows", () => {
    expect(parseWindowsProcessLines("\nWARNING: x\n12\tnot a number\t1\t1\t1\tx\n")).toEqual([]);
  });

  it("asks for each field it reads", () => {
    for (const field of ["ProcessId", "ParentProcessId", "Name", "PrivatePageCount", "KernelModeTime", "UserModeTime", "CreationDate"]) {
      expect(WINDOWS_PROCESS_SCRIPT).toContain(field);
    }
  });
});

describe("dropStaleParents", () => {
  const row = (pid: number, ppid: number, start: string): ProcessRow => ({ pid, ppid, name: `p${pid}`, cpuMs: 0, rssBytes: 0, start });

  it("unlinks a child from a parent pid that a later process now has", () => {
    const rows = [row(10, 1, "win:300"), row(20, 10, "win:200"), row(30, 10, "win:400")];
    expect(dropStaleParents(rows).map((each) => [each.pid, each.ppid])).toEqual([[10, 1], [20, 0], [30, 10]]);
  });

  it("keeps a link to a parent that started at the same time", () => {
    expect(dropStaleParents([row(10, 1, "win:300"), row(20, 10, "win:300")])[1]!.ppid).toBe(10);
  });

  it("keeps rows with no listed parent or no start time unchanged", () => {
    const rows = [row(10, 99, "win:300"), row(20, 10, "")];
    expect(dropStaleParents(rows)).toEqual(rows);
  });

  it("compares start times past the range of safe numbers", () => {
    const rows = [row(10, 1, "win:133000000000000002"), row(20, 10, "win:133000000000000001")];
    expect(dropStaleParents(rows)[1]!.ppid).toBe(0);
  });
});
