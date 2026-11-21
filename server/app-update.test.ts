import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  appRoot, backupData, backupFolder, copyDir, dataBytes, installCopy, npmOnPath, prepareUpdate, prune, readAppState, realDeps, restoreData, runningCopy, validCopy, writeAppState,
  type AppUpdateDeps,
} from "./app-update.ts";
import { fakeNpmExec, writeFakeCopy } from "./testing/fake-app-copies.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function data() {
  const root = mkdtempSync(join(tmpdir(), "seira-app-update-"));
  roots.push(root);
  const dir = join(root, "data");
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, "config.json"), '{"a":1}');
  mkdirSync(join(dir, "threads"));
  writeFileSync(join(dir, "threads", "t1.json"), "thread one");
  return { root, dir };
}

function deps(overrides: Partial<AppUpdateDeps> = {}, calls: string[][] = []): AppUpdateDeps {
  let clock = 1_800_000_000_000;
  return { ...realDeps(), exec: fakeNpmExec({}, [], calls), npmOnPath: () => true, now: () => clock++, ...overrides };
}

describe("installing a copy (AC-03)", () => {
  it("installs the version into app/<version> through a folder that does not count, and checks what it prints", async () => {
    const { dir } = data();
    const calls: string[][] = [];
    const result = await installCopy(dir, "0.1.200", deps({}, calls));
    expect(result).toEqual({ ok: true, dir: copyDir(dir, "0.1.200") });
    expect(calls[0]).toEqual(expect.arrayContaining(["install", "--prefix", "@seira-bot/seira@0.1.200", "--omit=dev"]));
    expect(validCopy(dir, { version: "0.1.200", dir: copyDir(dir, "0.1.200") })).not.toBeNull();
    expect(readdirSync(appRoot(dir)).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
  });

  it("refuses a copy that fails to install, or prints another version, and leaves nothing behind", async () => {
    const { dir } = data();
    expect(await installCopy(dir, "0.1.200", deps({ exec: fakeNpmExec({}, ["0.1.200"]) }))).toEqual({ ok: false });
    const wrong = fakeNpmExec({});
    expect(await installCopy(dir, "0.1.200", deps({ exec: async (command, args, options) => (command === "npm" ? (await wrong(command, args.map((arg) => arg.replace("0.1.200", "0.1.201")), options)) : wrong(command, args, options)) }))).toEqual({ ok: false });
    expect(existsSync(copyDir(dir, "0.1.200"))).toBe(false);
    expect(readdirSync(appRoot(dir)).filter((name) => /^\d/.test(name))).toEqual([]);
  });

  it("takes only an exact X.Y.Z", async () => {
    const { dir } = data();
    for (const bad of ["latest", "1.2", "1.2.3-beta", "../1.2.3", "1.2.3 && rm -rf /"]) expect(await installCopy(dir, bad, deps()), bad).toEqual({ ok: false });
  });
});

describe("the backup the launcher takes (AC-03)", () => {
  it("is a private tar.gz of the data folder without app, tools, logs and the update backups", async () => {
    const { dir } = data();
    for (const name of ["app", "tools", "logs"]) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "big"), "left out");
    }
    const result = await backupData(dir, "0.1.150", deps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(statSync(result.file).mode & 0o777).toBe(0o600);
    expect(result.file.startsWith(backupFolder(dir))).toBe(true);
    const listed = (await realDeps().exec("tar", ["-tzf", result.file], { timeoutMs: 20_000 })).out;
    expect(listed).toContain("config.json");
    expect(listed).toContain("threads/t1.json");
    expect(listed).not.toMatch(/(^|\/)(app|tools|logs)\//m);
    expect(listed).not.toContain(".backups/update");
  });

  it("is not made when tar fails", async () => {
    const { dir } = data();
    expect(await backupData(dir, "0.1.150", deps({ exec: async () => ({ code: 2, out: "" }) }))).toEqual({ ok: false });
    expect(readdirSync(backupFolder(dir))).toEqual([]);
  });
});

describe("putting the data back (AC-05)", () => {
  it("moves what is there aside, never deletes it, and leaves app, tools, logs and the update backups alone", async () => {
    const { dir } = data();
    mkdirSync(join(dir, "tools"));
    writeFileSync(join(dir, "tools", "bin"), "tool");
    const backup = await backupData(dir, "0.1.150", deps());
    if (!backup.ok) throw new Error("no backup");
    writeFileSync(join(dir, "config.json"), '{"migrated":true}');
    writeFileSync(join(dir, "new-file"), "from the new version");
    rmSync(join(dir, "threads"), { recursive: true });
    const restored = await restoreData(dir, backup.file, deps());
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(readFileSync(join(dir, "config.json"), "utf8")).toBe('{"a":1}');
    expect(readFileSync(join(dir, "threads", "t1.json"), "utf8")).toBe("thread one");
    expect(existsSync(join(dir, "new-file"))).toBe(false);
    expect(readFileSync(join(restored.aside, "new-file"), "utf8")).toBe("from the new version");
    expect(readFileSync(join(restored.aside, "config.json"), "utf8")).toBe('{"migrated":true}');
    expect(readFileSync(join(dir, "tools", "bin"), "utf8")).toBe("tool");
    expect(existsSync(backup.file)).toBe(true);
  });

  it("changes nothing when the archive cannot be read", async () => {
    const { dir } = data();
    mkdirSync(backupFolder(dir), { recursive: true });
    writeFileSync(join(backupFolder(dir), "bad.tgz"), "not an archive");
    const result = await restoreData(dir, join(backupFolder(dir), "bad.tgz"), deps());
    expect(result).toEqual({ ok: false, changed: false });
    expect(readFileSync(join(dir, "config.json"), "utf8")).toBe('{"a":1}');
  });
});

describe("what is checked before an update (AC-13)", () => {
  it("skips with no-updater when npm is not on the PATH, and says so in the state", async () => {
    const { dir } = data();
    const result = await prepareUpdate({ dataDir: dir, from: "0.1.150", to: "0.1.151", by: "admin" }, deps({ npmOnPath: () => false }));
    expect(result).toEqual({ ok: false, reason: "no-updater" });
    expect(readAppState(dir).last).toMatchObject({ outcome: "not-changed", reason: "no-updater", from: "0.1.150" });
    expect(existsSync(copyDir(dir, "0.1.151"))).toBe(false);
  });

  it("skips with no-room when free disk is less than twice the data", async () => {
    const { dir } = data();
    const size = await dataBytes(dir);
    expect(size).toBe("{\"a\":1}".length + "thread one".length);
    const tight = await prepareUpdate({ dataDir: dir, from: "0.1.150", to: "0.1.151", by: "admin" }, deps({ freeBytes: () => 2 * size - 1 }));
    expect(tight).toEqual({ ok: false, reason: "no-room" });
    expect(readAppState(dir).last).toMatchObject({ outcome: "not-changed", reason: "no-room" });
    const enough = await prepareUpdate({ dataDir: dir, from: "0.1.150", to: "0.1.151", by: "admin" }, deps({ freeBytes: () => 2 * size }));
    expect(enough.ok).toBe(true);
  });

  it("writes the pending update with the copy and who asked, and refuses a second one", async () => {
    const { dir } = data();
    const first = await prepareUpdate({ dataDir: dir, from: "0.1.150", to: "0.1.151", by: "automatic" }, deps());
    expect(first).toEqual({ ok: true, pending: expect.objectContaining({ from: "0.1.150", to: "0.1.151", dir: copyDir(dir, "0.1.151"), by: "automatic" }) });
    expect(readAppState(dir).pending).toMatchObject({ to: "0.1.151", by: "automatic" });
    expect(await prepareUpdate({ dataDir: dir, from: "0.1.150", to: "0.1.152", by: "admin" }, deps())).toEqual({ ok: false, reason: "busy" });
  });

  it("refuses a version that is not newer, and reports a failed install", async () => {
    const { dir } = data();
    expect(await prepareUpdate({ dataDir: dir, from: "0.1.150", to: "0.1.150", by: "admin" }, deps())).toEqual({ ok: false, reason: "older" });
    expect(await prepareUpdate({ dataDir: dir, from: "0.1.150", to: "0.1.151", by: "admin" }, deps({ exec: fakeNpmExec({}, ["0.1.151"]) }))).toEqual({ ok: false, reason: "failed" });
    expect(readAppState(dir).pending).toBeUndefined();
  });

  it("finds npm in the PATH folders", () => {
    expect(npmOnPath({ PATH: "/a:/b" }, (path) => path === "/b/npm")).toBe(true);
    expect(npmOnPath({ PATH: "/a:/b" }, () => false)).toBe(false);
    expect(npmOnPath({}, () => true)).toBe(false);
  });
});

describe("what stays in the data folder (AC-14)", () => {
  it("keeps 2 copies and 2 backups, and never the current, the pending or the running one", () => {
    const { dir } = data();
    for (const version of ["0.1.1", "0.1.2", "0.1.3", "0.1.4", "0.1.5"]) writeFakeCopy(copyDir(dir, version), version);
    writeAppState(dir, { failed: [], current: { version: "0.1.2", dir: copyDir(dir, "0.1.2") }, pending: { from: "0.1.2", to: "0.1.3", dir: copyDir(dir, "0.1.3"), at: 1, by: "admin" } });
    mkdirSync(join(appRoot(dir), ".tmp-0.1.9-1"));
    prune(dir, "0.1.1");
    expect(readdirSync(appRoot(dir)).filter((name) => /^\d/.test(name)).sort()).toEqual(["0.1.1", "0.1.2", "0.1.3"]);
    expect(readdirSync(appRoot(dir)).some((name) => name.startsWith(".tmp-"))).toBe(false);
    writeAppState(dir, { failed: [], current: { version: "0.1.3", dir: copyDir(dir, "0.1.3") } });
    prune(dir);
    expect(readdirSync(appRoot(dir)).filter((name) => /^\d/.test(name)).sort()).toEqual(["0.1.2", "0.1.3"]);
    expect(existsSync(copyDir(dir, "0.1.3"))).toBe(true);
  });

  it("keeps the 2 newest backups", () => {
    const { dir } = data();
    mkdirSync(backupFolder(dir), { recursive: true });
    for (let i = 1; i <= 4; i++) {
      const file = join(backupFolder(dir), `0.1.${i}-${i}.tgz`);
      writeFileSync(file, "x");
      utimesSync(file, i, i);
    }
    prune(dir);
    expect(readdirSync(backupFolder(dir)).sort()).toEqual(["0.1.3-3.tgz", "0.1.4-4.tgz"]);
  });

  it("keeps the backup an unfinished update needs, even when it is the oldest", () => {
    const { dir } = data();
    mkdirSync(backupFolder(dir), { recursive: true });
    for (let i = 1; i <= 4; i++) {
      const file = join(backupFolder(dir), `0.1.${i}-${i}.tgz`);
      writeFileSync(file, "x");
      utimesSync(file, i, i);
    }
    writeAppState(dir, { failed: [], pending: { from: "0.1.1", to: "0.1.2", dir: copyDir(dir, "0.1.2"), at: 1, by: "admin", backup: join(backupFolder(dir), "0.1.1-1.tgz") } });
    prune(dir);
    expect(readdirSync(backupFolder(dir)).sort()).toEqual(["0.1.1-1.tgz", "0.1.3-3.tgz", "0.1.4-4.tgz"]);
  });
});

describe("which copy may run", () => {
  it("accepts only <data dir>/app/<version> with a CLI inside", () => {
    const { dir, root } = data();
    writeFakeCopy(copyDir(dir, "0.1.9"), "0.1.9");
    expect(validCopy(dir, { version: "0.1.9", dir: copyDir(dir, "0.1.9") })).toBe(join(copyDir(dir, "0.1.9"), "node_modules", "@seira-bot", "seira", "cli.js"));
    writeFakeCopy(join(root, "elsewhere", "0.1.8"), "0.1.8");
    expect(validCopy(dir, { version: "0.1.8", dir: join(root, "elsewhere", "0.1.8") })).toBeNull();
    expect(validCopy(dir, { version: "0.1.7", dir: copyDir(dir, "0.1.7") })).toBeNull();
    expect(validCopy(dir, { version: "../x", dir: copyDir(dir, "../x") })).toBeNull();
    expect(validCopy(dir, undefined)).toBeNull();
  });

  it("refuses a copy whose CLI is a link that leaves app/", () => {
    const { dir, root } = data();
    writeFakeCopy(join(root, "outside"), "0.1.6");
    const copy = copyDir(dir, "0.1.6");
    mkdirSync(join(copy, "node_modules", "@seira-bot", "seira"), { recursive: true });
    symlinkSync(join(root, "outside", "node_modules", "@seira-bot", "seira", "cli.js"), join(copy, "node_modules", "@seira-bot", "seira", "cli.js"));
    expect(validCopy(dir, { version: "0.1.6", dir: copy })).toBeNull();
  });

  it("tells the copy a script belongs to", () => {
    const { dir } = data();
    writeFakeCopy(copyDir(dir, "0.1.9"), "0.1.9");
    expect(runningCopy(dir, join(copyDir(dir, "0.1.9"), "node_modules", "@seira-bot", "seira", "cli.js"))).toBe("0.1.9");
    expect(runningCopy(dir, "/usr/lib/node_modules/@seira-bot/seira/cli.js")).toBeUndefined();
    expect(runningCopy(dir, undefined)).toBeUndefined();
  });

  it("reads a damaged state file as empty", () => {
    const { dir } = data();
    mkdirSync(appRoot(dir));
    writeFileSync(join(appRoot(dir), "state.json"), "{not json");
    expect(readAppState(dir)).toEqual({ failed: [] });
    writeFileSync(join(appRoot(dir), "state.json"), JSON.stringify({ current: { version: "../../x", dir: "/" }, failed: ["1.2.3", "bad", 4] }));
    expect(readAppState(dir)).toEqual({ failed: ["1.2.3"] });
  });
});
