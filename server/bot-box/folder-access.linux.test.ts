// The real box, where it can run (Linux with an unprivileged bubblewrap): what a bot's folder list shows and allows.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TurnFolders } from "../folder-access.ts";
import { BotBox } from "./box.ts";
import { detectBox } from "./detect.ts";

const ENV = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", SEIRA_BOT_BOX: "1" };
const detection = detectBox({ env: ENV });
const write = (path: string) => `(echo x > "${path}") 2>/dev/null && echo "WROTE ${path}" || echo "REFUSED ${path}"`;

describe.skipIf(detection.box !== "bwrap")(`a bot's folders in a real box (${detection.box === "bwrap" ? "bubblewrap works here" : `skipped: ${detection.reason}`})`, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "seira-folders-real-")));
  const home = join(root, "home"), dataDir = join(home, ".seira"), cwd = join(dataDir, "task-workspaces", "bot-1", "thread-1");
  const work = join(home, "work"), frozen = join(work, "frozen"), docs = join(home, "docs"), secret = join(home, ".ssh", "id");
  let folders: TurnFolders | null = null;
  const box = new BotBox();
  beforeAll(async () => {
    for (const dir of [cwd, join(dataDir, "workspaces", "bot-1"), frozen, docs, join(home, ".ssh")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(frozen, "a.txt"), "kept");
    writeFileSync(join(docs, "a.txt"), "docs");
    writeFileSync(secret, "private");
    box.scopeFolders(() => folders);
    expect((await box.start({ dataDir, home, port: 1, env: ENV, denyEnv: new Set(), log: () => {} })).box).toBe("bwrap");
  });
  afterAll(async () => { await box.stop(); rmSync(root, { recursive: true, force: true }); });

  function run(script: string): Promise<string> {
    const wrapped = box.wrap({ command: "/bin/sh", args: ["-c", script], cwd, env: { ...ENV, HOME: home }, botId: "bot-1" })!;
    return new Promise((resolve) => {
      const child = spawn(wrapped.command, wrapped.args, { env: wrapped.env, stdio: ["ignore", "pipe", "pipe", ...wrapped.extraFds] });
      for (const fd of wrapped.extraFds) try { closeSync(fd); } catch {}
      let out = "";
      child.stdout?.on("data", (chunk) => { out += chunk; });
      child.stderr?.on("data", (chunk) => { out += chunk; });
      child.once("exit", () => { wrapped.release(); resolve(out); });
    });
  }

  it("refuses a write in a read-only grant inside a can-change grant, and allows one beside it", async () => {
    folders = { limited: false, grants: [{ path: work, write: true }, { path: frozen, write: false }] };
    const out = await run(`${write(join(frozen, "b.txt"))}; ${write(join(work, "c.txt"))}`);
    expect(out).toContain(`REFUSED ${join(frozen, "b.txt")}`);
    expect(out).toContain(`WROTE ${join(work, "c.txt")}`);
    expect(existsSync(join(frozen, "b.txt"))).toBe(false);
    expect(existsSync(join(work, "c.txt"))).toBe(true);
  }, 60_000);

  it("a limited box shows only the grants of HOME", async () => {
    folders = { limited: true, grants: [{ path: docs, write: false }] };
    const out = await run(`cat "${join(docs, "a.txt")}"; cat "${secret}" 2>&1; ${write(join(docs, "z.txt"))}`);
    expect(out).toContain("docs");
    expect(out).not.toContain("private");
    expect(out).toContain(`REFUSED ${join(docs, "z.txt")}`);
  }, 60_000);

  it("a bot with no folder setting keeps its whole HOME", async () => {
    folders = null;
    expect(await run(`cat "${secret}"`)).toContain("private");
  }, 60_000);
});

const DESKTOP_ENV = { PATH: ENV.PATH };
const desktop = detectBox({ env: DESKTOP_ENV });

describe.skipIf(desktop.box !== "bwrap")(`only the bots limited to chosen folders in a real box (${desktop.box === "bwrap" ? "bubblewrap works here" : `skipped: ${desktop.reason}`})`, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "seira-limited-real-")));
  const home = join(root, "home"), dataDir = join(home, ".seira");
  const project = join(home, "project"), secret = join(home, ".ssh", "id");
  const box = new BotBox();
  beforeAll(async () => {
    for (const dir of [join(dataDir, "workspaces", "bot-1"), project, join(home, ".ssh"), join(root, "other")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(project, "a.txt"), "project");
    writeFileSync(secret, "private");
    box.scopeFolders((botId) => botId === "bot-1" ? { limited: true, grants: [{ path: project, write: true }] } : botId === "bot-2" ? { limited: false, grants: [] } : null);
    const started = await box.start({ dataDir, home, port: 1, env: DESKTOP_ENV, denyEnv: new Set(), log: () => {} });
    expect(started).toMatchObject({ box: "bwrap", scope: "limited" });
  });
  afterAll(async () => { await box.stop(); rmSync(root, { recursive: true, force: true }); });

  it("runs a limited bot's command in its folders only, also in a working folder of its own choosing (AC-02)", async () => {
    const script = `cat "${join(project, "a.txt")}"; cat "${secret}" 2>&1; ${write(join(project, "b.txt"))}; ${write(join(home, "c.txt"))}; ${write(join(root, "outside.txt"))}; ${write(join(root, "other", "d.txt"))}`;
    const wrapped = box.wrap({ command: "/bin/sh", args: ["-c", script], cwd: project, conversationBot: "bot-1", threadId: "thread-1", env: { ...DESKTOP_ENV, HOME: home } })!;
    expect(wrapped).not.toBeNull();
    const out = await new Promise<string>((resolve) => {
      const child = spawn(wrapped.command, wrapped.args, { env: wrapped.env, stdio: ["ignore", "pipe", "pipe", ...wrapped.extraFds] });
      for (const fd of wrapped.extraFds) try { closeSync(fd); } catch {}
      let text = "";
      child.stdout?.on("data", (chunk) => { text += chunk; });
      child.stderr?.on("data", (chunk) => { text += chunk; });
      child.once("exit", () => { wrapped.release(); resolve(text); });
    });
    expect(out).toContain("project");
    expect(out).not.toContain("private");
    expect(out).toContain(`WROTE ${join(project, "b.txt")}`);
    expect(existsSync(join(home, "c.txt")), "HOME in the box is scratch that never reaches the real one").toBe(false);
    expect(existsSync(join(root, "outside.txt")), "a parent of a bound folder is the box's own scratch").toBe(false);
    expect(out).toContain(`REFUSED ${join(root, "other", "d.txt")}`);
    expect(existsSync(join(root, "other", "d.txt"))).toBe(false);
    expect(existsSync(join(project, "b.txt"))).toBe(true);
  }, 60_000);

  it("leaves a bot that is not limited, and a spawn of no bot, unboxed (AC-03)", () => {
    expect(box.wrap({ command: "/bin/sh", args: ["-c", "true"], cwd: join(dataDir, "task-workspaces", "bot-2", "thread-1"), env: DESKTOP_ENV })).toBeNull();
    expect(box.wrap({ command: "/bin/sh", args: ["-c", "true"], env: DESKTOP_ENV })).toBeNull();
  });
});
