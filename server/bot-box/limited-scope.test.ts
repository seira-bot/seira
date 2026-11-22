import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { TurnFolders } from "../folder-access.ts";
import { runInTurn } from "../crash-guard.ts";
import { boxAudienceKey, boxedSpawn, sharedBoxScope } from "../procs.ts";
import { botBox } from "./box.ts";
import { visibleInBox } from "./plan.ts";

// The box's gates listen on unix sockets, which Windows refuses at a file path.
describe.skipIf(process.platform === "win32")("a box for only the bots limited to chosen folders, through the spawn path", () => {
  const dirs: string[] = [];
  let folders: Record<string, TurnFolders | null> = {};
  afterEach(async () => {
    await botBox.stop();
    botBox.scopeFolders(null);
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function start(): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), "seira-limited-scope-"));
    dirs.push(root);
    const dataDir = join(root, "home", ".seira");
    folders = {};
    botBox.scopeFolders((botId) => folders[botId] ?? null);
    await botBox.start({
      dataDir, home: join(root, "home"), port: 8799, denyEnv: new Set(), env: {}, log: () => {},
      detect: () => ({ box: "bwrap", reason: null, tools: { bwrap: "/usr/bin/bwrap", socat: null }, scope: "limited" }),
    });
    return dataDir;
  }
  const spawnIn = (botId: string, threadId: string) => runInTurn({ botId, threadId }, () =>
    boxedSpawn({ command: "/usr/local/bin/claude", args: [] }, { env: { PATH: "/usr/bin" } }, "bot"));

  it("boxes a turn's spawn by the bot whose turn it is, even with no working folder that names it (AC-02, AC-03)", async () => {
    await start();
    folders = { limited: { limited: true, grants: [{ path: "/work/docs", write: false }] }, open: { limited: false, grants: [{ path: "/work/docs", write: false }] } };
    const boxed = spawnIn("limited", "t1");
    expect(boxed?.command).toBe("/usr/bin/bwrap");
    expect(visibleInBox(boxed!.plan, "/work/docs/a.md")).toBe("ro");
    expect(visibleInBox(boxed!.plan, "/work/other/a.md")).toBe("none");
    expect(spawnIn("open", "t1"), "a bot with folders but no limit runs as before").toBeNull();
    expect(spawnIn("none", "t1"), "a bot with no setting runs as before").toBeNull();
    expect(boxedSpawn({ command: "/usr/bin/git", args: [] }, { env: {} }, "bot"), "a bot spawn outside any turn").toBeNull();
    expect(boxedSpawn({ command: "/usr/bin/git", args: [] }, { env: {} }, "seira"), "the server's own spawn").toBeNull();
  });

  it("starts a kept process again when a bot's limit turns on or off (AC-11)", async () => {
    const dataDir = await start();
    const cwd = join(dataDir, "task-workspaces", "b1", "t1");
    const keys = () => runInTurn({ botId: "b1", threadId: "t1" }, () => [boxAudienceKey(cwd), sharedBoxScope(cwd)]);
    expect(keys(), "no setting: no box, the keys of an unboxed process").toEqual([null, null]);
    folders = { b1: { limited: false, grants: [{ path: "/work/a", write: true }] } };
    expect(keys(), "folders without a limit: still unboxed").toEqual([null, null]);
    folders = { b1: { limited: true, grants: [{ path: "/work/a", write: true }] } };
    const limited = keys();
    expect(limited[0]).not.toBeNull();
    expect(limited[1]).not.toBeNull();
    folders = { b1: { limited: true, grants: [{ path: "/work/a", write: false }] } };
    expect(keys()[0], "a changed list is a new box").not.toBe(limited[0]);
    folders = { b1: null };
    expect(keys()).toEqual([null, null]);
  });
});
