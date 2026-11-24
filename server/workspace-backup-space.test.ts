import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createWorkspaceBackupSnapshot } from "./workspace-backup.ts";
import { backupProblemsError, sizeText } from "./workspace-backup-space.ts";

const PASSWORD = "correct horse battery staple";
const scratch: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "seira-backup-space-"));
  scratch.push(path);
  return path;
}
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

const GB = 1024 ** 3;
const free = (bytes: number) => () => ({ bavail: bytes / 4096, bsize: 4096 });

it("stops before the copy and names the needed and free size when the disk is too full", async () => {
  const root = directory();
  writeFileSync(join(root, "big.bin"), Buffer.alloc(8 * 1024 ** 2));
  const failure = createWorkspaceBackupSnapshot(root, { password: PASSWORD }, undefined, { statfs: free(10 * 1024 ** 2) });
  await expect(failure).rejects.toThrow(/needs about 80 MB of free disk space, and 10 MB is free\. Free some space and try again\./);
  expect(readdirSync(join(root, ".backups"))).toEqual([]);
});

it("reports gigabytes with one decimal", () => {
  expect(sizeText(3.94 * GB)).toBe("3.9 GB");
  expect(sizeText(700 * 1024 ** 2)).toBe("700 MB");
});

it("runs as before when the disk has enough space", async () => {
  const root = directory();
  writeFileSync(join(root, "notes.txt"), "hello");
  const result = await createWorkspaceBackupSnapshot(root, { password: PASSWORD }, undefined, { statfs: free(50 * GB) });
  expect(existsSync(result.path)).toBe(true);
  expect(result.summary.files).toBe(1);
});

it("runs as before when the free space cannot be read", async () => {
  const root = directory();
  writeFileSync(join(root, "notes.txt"), "hello");
  const result = await createWorkspaceBackupSnapshot(root, { password: PASSWORD }, undefined, { statfs: () => { throw new Error("no statfs"); } });
  expect(existsSync(result.path)).toBe(true);
});

it("names every file that cannot be backed up in one error", async () => {
  const root = directory();
  const outside = directory();
  writeFileSync(join(outside, "secret"), "x");
  symlinkSync(join(outside, "secret"), join(root, "away"));
  symlinkSync(join(outside, "missing"), join(root, "gone"));
  mkdirSync(join(root, "workspaces", "bot"), { recursive: true });
  writeFileSync(join(root, "workspaces", "bot", "real"), "x");
  symlinkSync(join(root, "workspaces", "bot", "real"), join(root, "link"));
  const failure = createWorkspaceBackupSnapshot(root, { password: PASSWORD });
  await expect(failure).rejects.toThrow(/3 items cannot be backed up/);
  await expect(failure).rejects.toThrow(/symbolic link outside the workspace: away/);
  await expect(failure).rejects.toThrow(/dangling symbolic link: gone/);
  await expect(failure).rejects.toThrow(/user-created symbolic link.*: link/);
  expect(readdirSync(join(root, ".backups"))).toEqual([]);
});

it("lists the first 20 problems and counts the rest", () => {
  const error = backupProblemsError(Array.from({ length: 25 }, (_, index) => `problem ${index}`));
  expect(error.message).toContain("25 items cannot be backed up");
  expect(error.message).toContain("- problem 19");
  expect(error.message).not.toContain("problem 20");
  expect(error.message).toContain("- and 5 more");
});
