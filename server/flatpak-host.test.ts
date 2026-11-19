import { closeSync, fstatSync, readSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { distrustHomePrograms } from "./bot-box/program-trust.ts";
import {
  FLATPAK_SPAWN,
  hostBasePath,
  hostBridge,
  hostEnvEntries,
  hostEnvFile,
  hostFindCandidates,
  hostSpawnArgv,
  hostFindPrograms,
  inFlatpak,
  parseHostPrograms,
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

describe("hostEnvFile", () => {
  it("returns a nameless regular file, owner only, that reads back from offset 0", () => {
    const block = "A=1\0SECRET=sk-x\0";
    const fd = hostEnvFile(block);
    try {
      const stat = fstatSync(fd);
      expect(stat.isFile()).toBe(true);
      expect(stat.nlink).toBe(0);
      expect(stat.mode & 0o077).toBe(0);
      const buffer = Buffer.alloc(stat.size);
      readSync(fd, buffer, 0, buffer.length, 0);
      expect(buffer.toString()).toBe(block);
    } finally {
      closeSync(fd);
    }
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
  it("passes arguments as separate elements, never joined, and reads the environment from a descriptor", () => {
    const argv = hostSpawnArgv({ command: "/home/u/.local/bin/claude", args: ["-p", "a b; rm -rf /", "$(id)"], cwd: "/work dir" });
    expect(argv).toEqual([
      "--host",
      "--watch-bus",
      "--directory=/work dir",
      "--env-fd=3",
      "--",
      "/home/u/.local/bin/claude",
      "-p",
      "a b; rm -rf /",
      "$(id)",
    ]);
  });

  it("leaves out --directory without a working folder", () => {
    expect(hostSpawnArgv({ command: "x", args: [] })).toEqual(["--host", "--watch-bus", "--env-fd=3", "--", "x"]);
  });
});

describe("host lookups", () => {
  const calls: string[][] = [];
  let hostFiles: Map<string, string>;
  let hostPath: string;

  const runner: HostRunner = (argv) => {
    calls.push([...argv]);
    if (argv[1] === "printenv" && argv[2] === "PATH") return { status: 0, stdout: `${hostPath}\n` };
    if (argv[1] === "/bin/sh" && argv.length === 7) {
      const found = (argv[5] ?? "").split(":").map((d) => `${d}/${argv[6]}`).filter((p) => hostFiles.has(p));
      return { status: 0, stdout: found.map((p) => `${p}\0${hostFiles.get(p)}\0`).join("") };
    }
    if (argv[1] === "/bin/sh") return { status: 0, stdout: hostFiles.has(argv[5] ?? "") ? `${argv[5]}\0${hostFiles.get(argv[5]!)}\0` : "" };
    return { status: 1, stdout: "" };
  };

  beforeEach(() => {
    calls.length = 0;
    hostFiles = new Map([["/home/u/.local/bin/claude", "/home/u/.local/bin/claude"]]);
    hostPath = "/usr/local/bin:/usr/bin";
    setHostRunnerForTests(runner);
  });
  afterEach(() => {
    setHostRunnerForTests(null);
    distrustHomePrograms(null);
  });

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

  it("sees a program that is installed after a miss once the cache is reset", () => {
    expect(hostFindCandidates("codex", "/usr/local/bin")).toEqual([]);
    hostFiles.set("/usr/local/bin/codex", "/usr/local/bin/codex");
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

    it("builds a flatpak-spawn command line and carries the environment on a descriptor, never in argv", () => {
      const bridged = hostBridge(
        { command: "claude", args: ["--version"] },
        { cwd: "/work", env: { PATH: "/usr/bin:/home/u/.local/bin", API: "token-1", FLATPAK_ID: "x" } },
        { ...FLATPAK_ENV, DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", SECRET_FROM_APP: "no" },
      );
      expect(bridged?.command).toBe(FLATPAK_SPAWN);
      expect(bridged?.args).toEqual(["--host", "--watch-bus", "--directory=/work", "--env-fd=3", "--", "/home/u/.local/bin/claude", "--version"]);
      expect(bridged?.args.join(" ")).not.toContain("token-1");
      expect(bridged?.envBlock).toBe("PATH=/usr/bin:/home/u/.local/bin\0API=token-1\0");
      expect(bridged?.env?.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/1000/bus");
      expect(bridged?.env?.SECRET_FROM_APP).toBeUndefined();
    });

    it("leaves a folder the bots can write out of the host PATH, as outsideBoxOptions does", () => {
      distrustHomePrograms("/home/u", ["/home/u/data"], []);
      hostFiles.set("/usr/bin/claude", "/usr/bin/claude");
      const bridged = hostBridge({ command: "claude", args: [] }, { env: { PATH: "/home/u/.local/bin:/usr/bin" } }, FLATPAK_ENV);
      expect(bridged?.args.at(-1)).toBe("/usr/bin/claude");
      expect(bridged?.envBlock).toBe("PATH=/usr/bin\0");
    });

    it("refuses with EACCES a program whose link leads into a folder the bots can write", () => {
      distrustHomePrograms("/home/u", ["/home/u/data"], []);
      hostFiles.set("/usr/bin/claude", "/home/u/.local/bin/evil");
      expect(() => hostBridge({ command: "claude", args: [] }, { env: { PATH: "/usr/bin" } }, FLATPAK_ENV)).toThrow(expect.objectContaining({ code: "EACCES" }));
    });

    it("refuses with EACCES a path name in such a folder", () => {
      distrustHomePrograms("/home/u", ["/home/u/data"], []);
      expect(() => hostBridge({ command: "/home/u/.local/bin/claude", args: [] }, { env: { PATH: "/usr/bin" } }, FLATPAK_ENV)).toThrow(expect.objectContaining({ code: "EACCES" }));
    });

    it("launches the checked target, not the link it found", () => {
      hostFiles.set("/usr/bin/claude", "/opt/claude/bin/claude");
      const bridged = hostBridge({ command: "claude", args: [] }, { env: { PATH: "/usr/bin" } }, FLATPAK_ENV);
      expect(bridged?.args.at(-1)).toBe("/opt/claude/bin/claude");
    });

    it("looks again before a launch instead of trusting a cached answer", () => {
      hostFiles.set("/usr/bin/claude", "/opt/claude/bin/claude");
      expect(hostFindPrograms("claude", "/usr/bin")[0]?.real).toBe("/opt/claude/bin/claude");
      hostFiles.set("/usr/bin/claude", "/home/u/.local/bin/evil");
      distrustHomePrograms("/home/u", ["/home/u/data"], []);
      expect(() => hostBridge({ command: "claude", args: [] }, { env: { PATH: "/usr/bin" } }, FLATPAK_ENV)).toThrow(expect.objectContaining({ code: "EACCES" }));
    });

    it("refuses with EACCES a program whose target could not be resolved", () => {
      hostFiles.set("/usr/bin/claude", "");
      expect(() => hostBridge({ command: "claude", args: [] }, { env: { PATH: "/usr/bin" } }, FLATPAK_ENV)).toThrow(expect.objectContaining({ code: "EACCES" }));
    });
  });

  describe("parseHostPrograms", () => {
    it("reads path and target records", () => {
      expect(parseHostPrograms("/a\0/b\0/c\0/d\0")).toEqual([{ path: "/a", real: "/b" }, { path: "/c", real: "/d" }]);
    });
    it("keeps an empty target empty and never shifts the pairs", () => {
      expect(parseHostPrograms("/a\0\0/c\0/d\0")).toEqual([{ path: "/a", real: "" }, { path: "/c", real: "/d" }]);
    });
    it("gives a lone field an empty target", () => {
      expect(parseHostPrograms("/a\0/b\0/c\0")).toEqual([{ path: "/a", real: "/b" }, { path: "/c", real: "" }]);
    });
    it("reads nothing from nothing", () => {
      expect(parseHostPrograms("")).toEqual([]);
    });
  });
});
