import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { backupPartOf, partSizes, partSizesAsync, parseLeaveOut, singleFlightSizes } from "./workspace-backup-parts.ts";
import { dataBytes } from "./workspace-backup-space.ts";
import { createWorkspaceBackup, omittedFromWorkspaceBackup, createWorkspaceBackupSnapshot, stageWorkspaceBackup } from "./workspace-backup.ts";
import { readFileSync } from "node:fs";

const PASSWORD = "correct horse battery staple";
const scratch: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "seira-backup-parts-"));
  scratch.push(path);
  return path;
}
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

function write(root: string, path: string, bytes: number): void {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  // JSON files hold valid JSON of the exact size, so a real export can read them.
  if (full.endsWith(".json")) writeFileSync(full, path === "bots.json" ? `[${" ".repeat(bytes - 2)}]` : `{${" ".repeat(bytes - 2)}}`);
  else writeFileSync(full, Buffer.alloc(bytes, 1));
}
/** A data folder with a known size in each part. */
function fixture(): string {
  const root = directory();
  write(root, "bots.json", 10);
  write(root, "thread-starters.json", 20);
  write(root, "workspaces/bot/MEMORY.md", 300);
  write(root, "attachments/a.png", 4000);
  write(root, "task-workspaces/bot/thread/video.mp4", 50_000);
  write(root, "task-workspaces/bot/thread/node_modules/dep/index.js", 999);
  write(root, "notes.md", 7);
  write(root, ".backups/old/skip.bin", 888);
  return root;
}

it("puts each path in one part", () => {
  expect(backupPartOf("bots.json")).toBe("chats");
  expect(backupPartOf("messages.db-wal")).toBe("chats");
  expect(backupPartOf("workspaces/bot/MEMORY.md")).toBe("memory");
  expect(backupPartOf("attachments/a.png")).toBe("attachments");
  expect(backupPartOf("task-workspaces/bot/thread/x.bin")).toBe("work-folders");
  expect(backupPartOf("notes.md")).toBe("other");
});

it("reports the bytes of each part for a folder with known file sizes", () => {
  expect(partSizes(fixture())).toEqual({ chats: 30, memory: 300, attachments: 4000, "work-folders": 50_000, other: 7 });
});

it("does not count a part that is left out", () => {
  const root = fixture();
  expect(dataBytes(root)).toBe(54_337);
  expect(dataBytes(root, ["work-folders"])).toBe(4337);
});

it("accepts the fixed list and refuses any other value with a clear message", () => {
  expect(parseLeaveOut(undefined)).toEqual([]);
  expect(parseLeaveOut([])).toEqual([]);
  expect(parseLeaveOut(["work-folders", "work-folders"])).toEqual(["work-folders"]);
  expect(() => parseLeaveOut(["memory"])).toThrow('Cannot leave out "memory". Allowed: work-folders.');
  expect(() => parseLeaveOut(["work-folders", 3])).toThrow(/Cannot leave out "3"/);
  expect(() => parseLeaveOut("work-folders")).toThrow(/must be a list/);
});

it("leaves the conversation work folders out of an export and names them in the summary", async () => {
  const root = fixture();
  const exported = await createWorkspaceBackup(root, { password: PASSWORD, leaveOut: ["work-folders"] });
  expect(exported.summary.leftOut).toEqual(["work-folders"]);
  expect(exported.summary.warnings.some((warning) => warning.startsWith("Conversation work folders were left out by choice"))).toBe(true);
  const target = directory();
  const staged = await stageWorkspaceBackup(target, exported.path, { password: PASSWORD });
  const manifest = JSON.parse(readFileSync(join(target, ".backups", staged.id, "staged", "manifest.json"), "utf8"));
  const paths = manifest.entries.map((entry: { path: string }) => entry.path);
  expect(paths.some((path: string) => path.startsWith("task-workspaces"))).toBe(false);
  expect(paths).toContain("attachments/a.png");
  expect(paths).toContain("notes.md");
  expect(staged.summary?.leftOut).toEqual(["work-folders"]);
});

it("keeps everything and adds no leftOut when the option is absent", async () => {
  const exported = await createWorkspaceBackup(fixture(), { password: PASSWORD });
  expect(exported.summary.leftOut).toBeUndefined();
  const target = directory();
  const staged = await stageWorkspaceBackup(target, exported.path, { password: PASSWORD });
  const manifest = JSON.parse(readFileSync(join(target, ".backups", staged.id, "staged", "manifest.json"), "utf8"));
  expect(manifest.entries.map((entry: { path: string }) => entry.path)).toContain("task-workspaces/bot/thread/video.mp4");
});

it("refuses an unknown part name before it copies anything", async () => {
  const root = fixture();
  await expect(createWorkspaceBackupSnapshot(root, { password: PASSWORD, leaveOut: ["bots"] })).rejects.toThrow('Cannot leave out "bots". Allowed: work-folders.');
});

it("counts only the chosen parts in the space check", async () => {
  const root = directory();
  write(root, "task-workspaces/bot/thread/video.mp4", 8 * 1024 ** 2);
  write(root, "notes.md", 10);
  const free = () => ({ bavail: (70 * 1024 ** 2) / 4096, bsize: 4096 });
  await expect(createWorkspaceBackupSnapshot(root, { password: PASSWORD }, undefined, { statfs: free })).rejects.toThrow(/needs about 80 MB of free disk space, and 70 MB is free/);
  const exported = await createWorkspaceBackupSnapshot(root, { password: PASSWORD, leaveOut: ["work-folders"] }, undefined, { statfs: free });
  expect(exported.summary.leftOut).toEqual(["work-folders"]);
});

it("gives the same sizes with the async walk as with the sync walk", async () => {
  const root = fixture();
  expect(await partSizesAsync(root)).toEqual(partSizes(root));
  expect(await partSizesAsync(root, ["work-folders"])).toEqual(partSizes(root, ["work-folders"]));
});

it("does one walk for two calls at the same time, then a new walk for a later call", async () => {
  const root = fixture();
  let walks = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const once = singleFlightSizes(async (folder) => { walks += 1; await gate; return partSizes(folder); });
  const first = once(root);
  const second = once(root);
  expect(walks).toBe(1);
  release();
  const [a, b] = await Promise.all([first, second]);
  expect(a).toBe(b);
  expect(walks).toBe(1);
  await once(root);
  expect(walks).toBe(2);
});

it("skips the paths that the omit rule names, in both the sync and the async walk", async () => {
  const root = fixture();
  write(root, "tools/runtime.bin", 777);
  write(root, "cache/blob", 555);
  const withRule = partSizes(root, [], omittedFromWorkspaceBackup);
  expect(withRule.other).toBe(7);
  expect(partSizes(root).other).toBe(7 + 777 + 555);
  expect(await partSizesAsync(root, [], omittedFromWorkspaceBackup)).toEqual(withRule);
});
