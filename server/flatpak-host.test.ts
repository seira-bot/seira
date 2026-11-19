import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FLATPAK_SPAWN,
  hostBasePath,
  hostBridge,
  hostEnvEntries,
  hostFindCandidates,
  hostSpawnArgv,
  inFlatpak,
  resetHostCaches,
  runsInSandbox,
  setHostRunnerForTests,
  type HostRunner,
} from "./flatpak-host.ts";

const FLATPAK_ENV = { FLATPAK_ID: "bot.seira.Seira" } as NodeJS.ProcessEnv;

describe("inFlatpak", () => {
  it("is true only with a non-empty FLATPAK_ID", () => {
    expect(inFlatpak({ FLATPAK_ID: "bot.seira.Seira" })).toBe(true);
    expect(inFlatpak({ FLATPAK_ID: "" })).toBe(false);
    expect(inFlatpak({})).toBe(false);
  });
});

describe("hostEnvEntries", () => {
  it("forwards plain values and drops the sandbox's own", () => {
    const entries = hostEnvEntries({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "k",
      FLATPAK_ID: "bot.seira.Seira",
      XDG_RUNTIME_DIR: "/run/user/1000",
      ZYPAK_BIN: "/app/x",
      LD_LIBRARY_PATH: "/app/lib",
      "BAD NAME": "x",
      EMPTY: "",
    });
    expect(entries).toContain("PATH=/usr/bin");
    expect(entries).toContain("ANTHROPIC_API_KEY=k");
    expect(entries).toContain("EMPTY=");
    expect(entries.join("\n")).not.toMatch(/FLATPAK_ID|XDG_RUNTIME_DIR|ZYPAK|LD_LIBRARY_PATH|BAD NAME/);
  });
});

describe("hostSpawnArgv", () => {
  it("passes arguments as separate elements and never joins them", () => {
    const argv = hostSpawnArgv({ command: "/home/u/.local/bin/claude", args: ["-p", "a b; rm -rf /", "$(id)"], cwd: "/work dir", env: { A: "1" } });
    expect(argv).toEqual([
      "--host",
      "--watch-bus",
      "--directory=/work dir",
      "--env=A=1",
      "--",
      "/home/u/.local/bin/claude",
      "-p",
      "a b; rm -rf /",
      "$(id)",
    ]);
  });

  it("leaves out --directory without a working folder", () => {
    expect(hostSpawnArgv({ command: "x", args: [], env: {} })).toEqual(["--host", "--watch-bus", "--", "x"]);
  });
});

describe("host lookups", () => {
  const calls: string[][] = [];
  let hostFiles: Set<string>;
  let hostPath: string;

  const runner: HostRunner = (argv) => {
    calls.push([...argv]);
    if (argv[1] === "printenv" && argv[2] === "PATH") return { status: 0, stdout: `${hostPath}\n` };
    if (argv[1] === "/bin/sh" && argv.length === 7) {
      const found = (argv[5] ?? "").split(":").map((d) => `${d}/${argv[6]}`).filter((p) => hostFiles.has(p));
      return { status: 0, stdout: found.map((p) => `${p}\n`).join("") };
    }
    if (argv[1] === "/bin/sh") return { status: 0, stdout: hostFiles.has(argv[5] ?? "") ? `${argv[5]}\n` : "" };
    return { status: 1, stdout: "" };
  };

  beforeEach(() => {
    calls.length = 0;
    hostFiles = new Set(["/home/u/.local/bin/claude"]);
    hostPath = "/usr/local/bin:/usr/bin";
    setHostRunnerForTests(runner);
  });
  afterEach(() => setHostRunnerForTests(null));

  it("reads the host PATH once", () => {
    hostPath = "/a:/b";
    expect(hostBasePath()).toBe("/a:/b");
    hostPath = "/changed";
    expect(hostBasePath()).toBe("/a:/b");
  });

  it("falls back to the default PATH when the host does not answer", () => {
    setHostRunnerForTests(() => ({ status: 1, stdout: "" }));
    expect(hostBasePath()).toBe("/usr/local/bin:/usr/bin");
  });

  it("finds a program on the host and returns nothing for a missing one", () => {
    expect(hostFindCandidates("claude", "/usr/bin:/home/u/.local/bin")).toEqual(["/home/u/.local/bin/claude"]);
    expect(hostFindCandidates("codex", "/usr/bin:/home/u/.local/bin")).toEqual([]);
  });

  it("sends the name and the PATH as positional arguments, not inside the script", () => {
    hostFindCandidates("cl$(touch x)aude", "/p");
    const call = calls.at(-1)!;
    expect(call.slice(0, 3)).toEqual(["--host", "/bin/sh", "-c"]);
    expect(call[3]).not.toContain("touch");
    expect(call.slice(-2)).toEqual(["/p", "cl$(touch x)aude"]);
  });

  it("sees a program that is installed after a miss once the short cache ends", () => {
    expect(hostFindCandidates("codex", "/usr/local/bin")).toEqual([]);
    hostFiles.add("/usr/local/bin/codex");
    resetHostCaches();
    expect(hostFindCandidates("codex", "/usr/local/bin")).toEqual(["/usr/local/bin/codex"]);
  });

  it("checks a path name on the host directly", () => {
    expect(hostFindCandidates("/home/u/.local/bin/claude", "/ignored")).toEqual(["/home/u/.local/bin/claude"]);
    expect(hostFindCandidates("/nope/claude", "/ignored")).toEqual([]);
  });

  describe("hostBridge", () => {
    it("returns null off Flatpak", () => {
      expect(hostBridge({ command: "claude", args: [] }, {}, {})).toBeNull();
    });

    it("returns null for the app's own files", () => {
      expect(runsInSandbox("/app/bin/zypak-wrapper")).toBe(true);
      expect(runsInSandbox(process.execPath)).toBe(true);
      expect(runsInSandbox("claude")).toBe(false);
      expect(hostBridge({ command: process.execPath, args: ["server.js"] }, {}, FLATPAK_ENV)).toBeNull();
    });

    it("returns null for a program the host does not have, so the caller sees the usual ENOENT", () => {
      expect(hostBridge({ command: "codex", args: [] }, { env: { PATH: "/usr/bin" } }, FLATPAK_ENV)).toBeNull();
    });

    it("builds a flatpak-spawn command line for a program on the host", () => {
      const bridged = hostBridge(
        { command: "claude", args: ["--version"] },
        { cwd: "/work", env: { PATH: "/usr/bin:/home/u/.local/bin", API: "1", FLATPAK_ID: "x" } },
        { ...FLATPAK_ENV, DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", SECRET_FROM_APP: "no" },
      );
      expect(bridged?.command).toBe(FLATPAK_SPAWN);
      expect(bridged?.args).toEqual([
        "--host",
        "--watch-bus",
        "--directory=/work",
        "--env=PATH=/usr/bin:/home/u/.local/bin",
        "--env=API=1",
        "--",
        "/home/u/.local/bin/claude",
        "--version",
      ]);
      expect(bridged?.env?.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/1000/bus");
      expect(bridged?.env?.SECRET_FROM_APP).toBeUndefined();
    });
  });
});
