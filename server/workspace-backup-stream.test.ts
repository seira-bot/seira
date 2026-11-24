import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { backupSpaceNeeded } from "./workspace-backup-space.ts";
import { createWorkspaceBackupSnapshot, stagedWorkspaceData, stageWorkspaceBackup } from "./workspace-backup.ts";

// Synthetic data only. The export reads each file twice and writes no copy of it.
const PASSWORD = "fixture-backup-password-only";
const scratch: string[] = [];
const folder = () => { const path = mkdtempSync(join(tmpdir(), "seira-backup-stream-")); scratch.push(path); return path; };
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
const put = (root: string, path: string, text: string) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); };
const jobs = (root: string) => (existsSync(join(root, ".backups")) ? readdirSync(join(root, ".backups")) : []);

it("restores every file with the hashes the manifest names", async () => {
  const root = folder();
  put(root, "workspaces/bot/a.txt", "synthetic alpha");
  put(root, "workspaces/bot/big.bin", "x".repeat(1024 * 1024 + 7));
  put(root, "notes.md", "");
  const made = await createWorkspaceBackupSnapshot(root, { password: PASSWORD });
  const target = folder();
  const staged = await stageWorkspaceBackup(target, made.path, { password: PASSWORD });
  const { data } = stagedWorkspaceData(target, staged.id);
  expect(readFileSync(join(data, "workspaces/bot/a.txt"), "utf8")).toBe("synthetic alpha");
  expect(readFileSync(join(data, "workspaces/bot/big.bin"), "utf8")).toBe("x".repeat(1024 * 1024 + 7));
  expect(readFileSync(join(data, "notes.md"), "utf8")).toBe("");
  expect(made.summary.files).toBe(3);
});

it("keeps no full snapshot copy of a plain file", async () => {
  const root = folder();
  put(root, "notes.md", "synthetic");
  let copied = true;
  await createWorkspaceBackupSnapshot(root, { password: PASSWORD }, undefined, {
    betweenReads: () => { copied = jobs(root).some((id) => existsSync(join(root, ".backups", id, "snapshot", "data", "notes.md"))); },
  });
  expect(copied).toBe(false);
});

const refuses = async (change: (root: string) => void, setup: (root: string) => void = (root) => put(root, "workspaces/bot/a.txt", "synthetic alpha")) => {
  const root = folder();
  setup(root);
  await expect(createWorkspaceBackupSnapshot(root, { password: PASSWORD }, undefined, { betweenReads: () => change(root) })).rejects.toThrow(/changed during backup: .*Stop its writer and retry/);
  expect(jobs(root)).toEqual([]);
};

it("refuses a file that grows between the two reads, and leaves no download", () => refuses((root) => appendFileSync(join(root, "workspaces/bot/a.txt"), " more")));
it("refuses a same-size edit between the two reads, and leaves no download", () => refuses((root) => writeFileSync(join(root, "workspaces/bot/a.txt"), "synthetic omega")));
it("refuses a link that points elsewhere after the walk, and leaves no download", () => refuses(
  (root) => { unlinkSync(join(root, "workspaces/bot/link.txt")); symlinkSync(join(root, "workspaces/bot/b.txt"), join(root, "workspaces/bot/link.txt")); },
  (root) => { put(root, "workspaces/bot/a.txt", "synthetic alpha"); put(root, "workspaces/bot/b.txt", "synthetic alpha"); symlinkSync(join(root, "workspaces/bot/a.txt"), join(root, "workspaces/bot/link.txt")); },
));
it("refuses a file replaced by another file of the same size, and leaves no download", () => refuses((root) => {
  unlinkSync(join(root, "workspaces/bot/a.txt")); put(root, "workspaces/bot/a.txt", "synthetic alpha");
}));

it("leaves credential fixtures out of the archive", async () => {
  const root = folder();
  put(root, "notes.md", "synthetic");
  put(root, "sessions.json", "{}");
  put(root, "tunnel-account.json", "{}");
  put(root, "engine-homes/x/token.txt", "fixture-token-not-real");
  const made = await createWorkspaceBackupSnapshot(root, { password: PASSWORD });
  const target = folder();
  const staged = await stageWorkspaceBackup(target, made.path, { password: PASSWORD });
  const { data } = stagedWorkspaceData(target, staged.id);
  expect(existsSync(join(data, "notes.md"))).toBe(true);
  for (const path of ["sessions.json", "tunnel-account.json", "engine-homes"]) expect(existsSync(join(data, path))).toBe(false);
});

it("counts the archive and the database copies in the space rule", () => {
  expect(backupSpaceNeeded(100, 40) - backupSpaceNeeded(100)).toBe(40);
  expect(backupSpaceNeeded(100)).toBeGreaterThan(100);
});

it("leaves no download and no job folder when an export fails", async () => {
  const root = folder();
  put(root, "workspaces/bot/a.txt", "synthetic alpha");
  await expect(createWorkspaceBackupSnapshot(root, { password: PASSWORD }, undefined, {
    betweenReads: () => appendFileSync(join(root, "workspaces/bot/a.txt"), " more"),
  })).rejects.toThrow(/changed during backup/);
  expect(jobs(root)).toEqual([]);
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [e.name]));
  expect(files(root).filter((name) => name.endsWith(".seirabackup"))).toEqual([]);
  // The next export, once the writer has stopped, works.
  const next = await createWorkspaceBackupSnapshot(root, { password: PASSWORD });
  expect(existsSync(next.path)).toBe(true);
});
