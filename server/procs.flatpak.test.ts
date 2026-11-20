import { EventEmitter } from "node:events";
import { fstatSync, readSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned: { command: string; args: string[]; options: Record<string, unknown>; envText: string | null; envIsFile: boolean }[] = [];

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((command: string, args: string[], options: Record<string, unknown>) => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdio: [null, null, null, null],
        pid: undefined,
        kill: () => true,
      });
      const fd = Array.isArray(options.stdio) ? options.stdio[3] : undefined;
      let envText: string | null = null;
      let envIsFile = false;
      if (typeof fd === "number") {
        envIsFile = fstatSync(fd).isFile();
        const buffer = Buffer.alloc(fstatSync(fd).size);
        readSync(fd, buffer, 0, buffer.length, 0);
        envText = buffer.toString();
      }
      spawned.push({ command, args, options, envText, envIsFile });
      return child;
    }),
  };
});

import { botBox, type WrappedSpawn } from "./bot-box/box.ts";
import { resetPathCacheForTests } from "./env-path.ts";
import { FLATPAK_SPAWN, setHostRunnerForTests, type HostRunner } from "./flatpak-host.ts";
import { spawnCli } from "./procs.ts";

const SECRET = "sk-secret-value-123";
const pipes = ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"];

const hostHasClaude: HostRunner = (argv) => {
  if (argv[1] === "printenv") return { status: 0, stdout: "/usr/local/bin:/usr/bin\n" };
  if (argv[1] === "/bin/sh" && argv.at(-1) === "claude") return { status: 0, stdout: "/home/u/.local/bin/claude\0/opt/claude/bin/claude\0" };
  return { status: 0, stdout: "" };
};

describe("spawnCli in a Flatpak", () => {
  beforeEach(() => {
    spawned.length = 0;
    resetPathCacheForTests();
    setHostRunnerForTests(hostHasClaude);
  });
  afterEach(() => {
    delete process.env.FLATPAK_ID;
    vi.restoreAllMocks();
    setHostRunnerForTests(null);
    resetPathCacheForTests();
  });

  it("starts an unboxed program on the host and keeps every environment value out of argv", () => {
    process.env.FLATPAK_ID = "bot.seira.Seira";
    vi.spyOn(botBox, "wrap").mockReturnValue(null);
    spawnCli("claude", ["-p", "hello"], { env: { PATH: "/usr/bin:/home/u/.local/bin", ANTHROPIC_API_KEY: SECRET }, cwd: "/work", stdio: pipes }, "bot");
    expect(spawned).toHaveLength(1);
    const call = spawned[0]!;
    expect(call.command).toBe(FLATPAK_SPAWN);
    expect(call.args).toEqual(["--host", "--watch-bus", "--directory=/work", "--env-fd=3", "--", "/home/u/.local/bin/claude", "-p", "hello"]);
    expect(JSON.stringify([call.command, call.args])).not.toContain(SECRET);
    expect((call.options.stdio as unknown[]).slice(0, 3)).toEqual(["pipe", "pipe", "pipe"]);
    expect(typeof (call.options.stdio as unknown[])[3]).toBe("number");
    expect(call.envIsFile).toBe(true);
    expect(call.options.cwd).toBeUndefined();
    expect(JSON.stringify(call.options.env)).not.toContain(SECRET);
    expect(call.envText).toContain(`ANTHROPIC_API_KEY=${SECRET}\0`);
  });

  it("refuses a boxed spawn, because the box's paths do not exist on the host", () => {
    process.env.FLATPAK_ID = "bot.seira.Seira";
    const release = vi.fn();
    vi.spyOn(botBox, "wrap").mockReturnValue({ command: "/usr/bin/bwrap", args: ["--", "claude"], env: {}, token: null, release, unbrokered: [], extraFds: [] } as unknown as WrappedSpawn);
    expect(() => spawnCli("claude", [], { env: { PATH: "/usr/bin" }, stdio: pipes }, "bot")).toThrow(expect.objectContaining({ code: "EACCES" }));
    expect(spawned).toHaveLength(0);
    expect(release).toHaveBeenCalledOnce();
  });

  it("runs the program here, as before, off Flatpak", () => {
    vi.spyOn(botBox, "wrap").mockReturnValue(null);
    spawnCli("claude", ["-p"], { env: { PATH: "/usr/bin" }, stdio: pipes }, "bot");
    expect(spawned[0]?.command).toBe("claude");
    expect(spawned[0]?.args).toEqual(["-p"]);
  });
});
