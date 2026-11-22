import { execFile } from "node:child_process";

import type { ProcessRow } from "./process-buckets.ts";
import type { ProcessList } from "./process-sampler.ts";

/** One line per process, tab separated, the name last. Win32_Process gives CPU time in 100 ns units, and
 * PrivatePageCount in bytes: the committed memory that a job's memory limit counts. */
export const WINDOWS_PROCESS_SCRIPT =
  "$ErrorActionPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
  "Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,Name,PrivatePageCount,KernelModeTime,UserModeTime,CreationDate|" +
  "ForEach-Object{$c=0;if($_.CreationDate){$c=$_.CreationDate.ToFileTimeUtc()};" +
  "\"$($_.ProcessId)`t$($_.ParentProcessId)`t$([uint64]$_.PrivatePageCount)`t$([uint64]$_.KernelModeTime+[uint64]$_.UserModeTime)`t$c`t$($_.Name)\"}";

export function parseWindowsProcessLines(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\d+)\t(\d+)\t(\d+)\t(\d+)\t(\d+)\t(.+)$/.exec(line.trim());
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === 0) continue;
    rows.push({
      pid,
      ppid: Number(match[2]),
      name: match[6]!.trim().toLowerCase(),
      cpuMs: Number(match[4]) / 10_000,
      rssBytes: Number(match[3]),
      start: `win:${match[5]}`,
    });
  }
  return rows;
}

const startOf = (row: ProcessRow): bigint | null => {
  const found = /^win:(\d+)$/.exec(row.start ?? "");
  return found ? BigInt(found[1]!) : null;
};

/** Windows keeps a dead parent's pid in its children, and can give that pid to a new process. A parent that started after
 * the child is not its parent: the child gets ppid 0. */
export function dropStaleParents(rows: readonly ProcessRow[]): ProcessRow[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  return rows.map((row) => {
    const parent = byPid.get(row.ppid);
    const own = startOf(row);
    const theirs = parent ? startOf(parent) : null;
    return own !== null && theirs !== null && theirs > own ? { ...row, ppid: 0 } : row;
  });
}

export function windowsProcessList(): Promise<ProcessList | null> {
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_SCRIPT],
      { timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
        if (error) return resolve(null);
        const rows = dropStaleParents(parseWindowsProcessLines(stdout));
        resolve(rows.length ? { rows, reapedMs: null, totalMs: null } : null);
      });
  });
}
