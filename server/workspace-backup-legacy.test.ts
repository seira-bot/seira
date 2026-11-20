import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createWorkspaceBackupSnapshot, readStagedWorkspaceBackup, stageWorkspaceBackup } from "./workspace-backup.ts";

const PASSWORD = "correct horse battery staple";
const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
const directory = () => { const path = mkdtempSync(join(tmpdir(), "seira-legacy-backup-")); scratch.push(path); return path; };

/** The same backup as an earlier version wrote it: its magic, its format id and its browser keys. */
async function asEarlierVersionWroteIt(path: string): Promise<string> {
  const tar = await import("tar");
  const bytes = readFileSync(path);
  const magic = Buffer.from("SEIRA-WORKSPACE-1\n");
  const salt = bytes.subarray(magic.length, magic.length + 16);
  const key = scryptSync(PASSWORD, salt, 32, { N: 131_072, r: 8, p: 1, maxmem: 256 * 1024 ** 2 });
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(magic.length + 16, magic.length + 28));
  decipher.setAAD(bytes.subarray(0, magic.length + 28));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  const archive = Buffer.concat([decipher.update(bytes.subarray(magic.length + 28, bytes.length - 16)), decipher.final()]);
  const work = directory();
  writeFileSync(join(work, "plain.tar"), archive);
  const unpacked = join(work, "unpacked");
  mkdirSync(unpacked);
  await tar.x({ file: join(work, "plain.tar"), cwd: unpacked });
  const manifest = JSON.parse(readFileSync(join(unpacked, "manifest.json"), "utf8"));
  manifest.summary.format = "openmaus.workspace-backup";
  manifest.clientState = { "omb-drafts": "kept" };
  writeFileSync(join(unpacked, "manifest.json"), JSON.stringify(manifest));
  await tar.c({ file: join(work, "old.tar"), cwd: unpacked, portable: true }, readdirSync(unpacked));
  const legacyMagic = Buffer.from("OMB-WORKSPACE-1\n");
  const iv = randomBytes(12);
  const header = Buffer.concat([legacyMagic, salt, iv]);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(readFileSync(join(work, "old.tar"))), cipher.final()]);
  const out = join(work, "workspace.ombbackup");
  writeFileSync(out, Buffer.concat([header, body, cipher.getAuthTag()]));
  return out;
}

describe("a workspace backup an earlier version wrote", () => {
  it("opens, and reads as the current format with the current browser keys", async () => {
    const root = directory();
    writeFileSync(join(root, "config.json"), JSON.stringify({ language: "en" }));
    const made = await createWorkspaceBackupSnapshot(root, { password: PASSWORD, appVersion: "test" });
    const legacy = await asEarlierVersionWroteIt(made.path);
    const destination = directory();
    const staged = await stageWorkspaceBackup(destination, legacy, { password: PASSWORD, currentAppVersion: "test" });
    expect(staged.summary.format).toBe("seira.workspace-backup");
    expect(readStagedWorkspaceBackup(destination, staged.id).clientState).toEqual({ "seira-drafts": "kept" });
  }, 60_000);

  it("refuses a file that has neither magic", async () => {
    const root = directory();
    const file = join(root, "x.seirabackup");
    writeFileSync(file, Buffer.alloc(200, 1));
    await expect(stageWorkspaceBackup(directory(), file, { password: PASSWORD, currentAppVersion: "test" })).rejects.toThrow("not a supported");
  });
});
