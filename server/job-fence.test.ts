import { EventEmitter } from "node:events";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { JOB_FENCE_ENV, jobBaseName, jobFenceArgv, jobFenceEnv, jobFencePath, parseJobFenceLine, startJobHold } from "./job-fence.ts";

const MIB = 1024 * 1024;

function fakeHelper() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: null,
    killed: false,
    kill: vi.fn(() => { child.emit("exit", null, "SIGTERM"); return true; }),
    unref: vi.fn(),
  });
  const written: string[] = [];
  child.stdin.on("data", (chunk: Buffer) => written.push(...chunk.toString("utf8").split("\n").filter(Boolean)));
  child.stdin.on("finish", () => child.emit("exit", 0, null));
  const say = (event: object) => child.stdout.write(`${JSON.stringify(event)}\n`);
  return { child, written, say };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("job fence paths and names", () => {
  it("prefers the packaged helper, then the built one in the repository", () => {
    const resources = join("app", "resources");
    const packaged = join(resources, "job-fence", "seira-job-fence.exe");
    expect(jobFencePath({ SEIRA_RESOURCES_PATH: resources }, (path) => path === packaged)).toBe(packaged);
    const built = jobFencePath({}, (path) => path.endsWith(join("dist-native", "job-fence", "win32-x64", "seira-job-fence.exe")));
    expect(built).toMatch(/seira-job-fence\.exe$/);
    expect(jobFencePath({ SEIRA_RESOURCES_PATH: resources }, () => false)).toBeNull();
  });

  it("names the job from the home, the same each time and different per home", () => {
    expect(jobBaseName("/home/a")).toMatch(/^Local\\Seira-bots-[0-9a-f]{10}$/);
    expect(jobBaseName("/home/a")).toBe(jobBaseName("/home/a"));
    expect(jobBaseName("/home/a")).not.toBe(jobBaseName("/home/b"));
  });

  it("puts the program after -- and names the job in the environment", () => {
    expect(jobFenceArgv("fence.exe", "C:\\node.exe", ["a b", ""])).toEqual({ command: "fence.exe", args: ["--", "C:\\node.exe", "a b", ""] });
    expect(jobFenceEnv({ PATH: "x" }, "Local\\Seira-bots-1-2")).toEqual({ PATH: "x", [JOB_FENCE_ENV]: "Local\\Seira-bots-1-2" });
  });

  it("refuses a .bat or .cmd program with EINVAL, whatever its spelling", () => {
    for (const command of ["C:\\x\\codex.cmd", "codex.CMD", "run.bat", "run.bat.", "run.cmd .", "run.Cmd  "]) {
      expect(() => jobFenceArgv("fence.exe", command, [])).toThrow(expect.objectContaining({ code: "EINVAL" }));
    }
    expect(jobFenceArgv("fence.exe", "C:\\x\\cmd.exe", []).args).toEqual(["--", "C:\\x\\cmd.exe"]);
    expect(jobFenceArgv("fence.exe", "C:\\cmd\\batch", []).args).toEqual(["--", "C:\\cmd\\batch"]);
  });
});

describe("parseJobFenceLine", () => {
  it("reads each event the helper prints", () => {
    expect(parseJobFenceLine('{"event":"ready","job":"Local\\\\Seira-bots-a-1","limitBytes":1048576,"pid":1}')).toEqual({ event: "ready", job: "Local\\Seira-bots-a-1", limitBytes: MIB, pid: 1 });
    expect(parseJobFenceLine('{"event":"memory-stop","pid":5,"name":"node.exe","bytes":9,"jobBytes":10,"limitBytes":11,"root":4,"helper":3,"by":5}')).toMatchObject({ event: "memory-stop", pid: 5, name: "node.exe" });
    expect(parseJobFenceLine('{"event":"error","step":"stop","code":5,"pid":9}')).toMatchObject({ event: "error", step: "stop" });
  });

  it("drops what is not an event", () => {
    for (const line of ["", "not json", "null", "[]", '{"event":"other"}', '{"event":"limit"}', '{"event":"limit","limitBytes":-1}', '{"event":"ready","limitBytes":1,"pid":1}', '{"event":"stats","processes":1,"jobBytes":1,"peakBytes":"2","limitBytes":3}']) {
      expect(parseJobFenceLine(line)).toBeNull();
    }
  });
});

describe("startJobHold", () => {
  it("starts hold with the limit in MiB and resolves on ready", async () => {
    const { child, say } = fakeHelper();
    const start = vi.fn(() => child as never);
    const pending = startJobHold({ helper: "fence.exe", base: "Local\\Seira-bots-a", limitBytes: 3 * 1024 * MIB + 5, start });
    expect(start).toHaveBeenCalledWith("fence.exe", ["hold", "Local\\Seira-bots-a", "3072"]);
    say({ event: "ready", job: "Local\\Seira-bots-a-7", limitBytes: 3072 * MIB, pid: 7 });
    const hold = await pending;
    expect(hold).toMatchObject({ job: "Local\\Seira-bots-a-7", pid: 7 });
    expect(hold!.alive()).toBe(true);
    expect(child.unref).toHaveBeenCalled();
  });

  it("sends a new limit only when it changes, and passes events on", async () => {
    const { child, written, say } = fakeHelper();
    const events: unknown[] = [];
    const pending = startJobHold({ helper: "f", base: "b", limitBytes: 512 * MIB, start: () => child as never, onEvent: (event) => events.push(event) });
    say({ event: "ready", job: "b-1", limitBytes: 512 * MIB, pid: 1 });
    const hold = (await pending)!;
    hold.setLimit(512 * MIB + 100);
    hold.setLimit(640 * MIB);
    hold.stats();
    await flush();
    expect(written).toEqual(["limit 640", "stats"]);
    expect(hold.limitBytes()).toBe(640 * MIB);
    say({ event: "memory-stop", pid: 9, name: "node.exe", bytes: 1, jobBytes: 2, limitBytes: 3, root: 8, helper: 7, by: 9 });
    say({ event: "nonsense" });
    await flush();
    expect(events.map((event) => (event as { event: string }).event)).toEqual(["ready", "memory-stop"]);
  });

  it("closes stdin to stop the helper, and reports the exit once", async () => {
    const { child, say } = fakeHelper();
    const onExit = vi.fn();
    const pending = startJobHold({ helper: "f", base: "b", limitBytes: MIB, start: () => child as never, onExit });
    say({ event: "ready", job: "b-1", limitBytes: MIB, pid: 1 });
    const hold = (await pending)!;
    hold.close();
    await flush();
    child.emit("exit", 0, null);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(hold.alive()).toBe(false);
    hold.setLimit(9 * MIB);
  });

  it("gives null when the helper exits before ready, fails to start, or is too slow", async () => {
    const early = fakeHelper();
    const onExit = vi.fn();
    const first = startJobHold({ helper: "f", base: "b", limitBytes: MIB, start: () => early.child as never, onExit });
    early.say({ event: "error", step: "create", code: 5 });
    early.child.emit("exit", 1, null);
    expect(await first).toBeNull();
    expect(onExit).toHaveBeenCalledTimes(1);

    expect(await startJobHold({ helper: "f", base: "b", limitBytes: MIB, start: () => { throw new Error("ENOENT"); } })).toBeNull();

    vi.useFakeTimers();
    try {
      const slow = fakeHelper();
      const third = startJobHold({ helper: "f", base: "b", limitBytes: MIB, start: () => slow.child as never, readyMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await third).toBeNull();
      expect(slow.child.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
