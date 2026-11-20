// Where an engine keeps its login and settings is its profile folder: USERPROFILE on Windows, HOME elsewhere. A HOME
// that a POSIX-flavoured shell (Git Bash, MSYS) leaves in the environment names another folder on Windows, so the
// server asks userHome() and never reads the two variables on its own.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { claudeToolSearchSetting } from "./drivers/claude-tool-search.ts";
import { resolveClaudeConfigDir } from "./drivers/claude.ts";
import { userHome } from "./env-path.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const onPlatform = (name: NodeJS.Platform) => vi.spyOn(process, "platform", "get").mockReturnValue(name);
afterEach(() => vi.restoreAllMocks());

describe("the profile folder", () => {
  // Absolute on the machine that runs the test; C:\ paths are not absolute to Linux's path module.
  const msys = "/c/msys/home/me", windows = "/c/Users/me";

  it("is USERPROFILE on Windows, even when a shell left a different HOME", () => {
    onPlatform("win32");
    expect(userHome({ HOME: msys, USERPROFILE: windows })).toBe(windows);
    expect(userHome({ HOME: msys })).toBe(msys);
    expect(userHome({})).toBe(homedir());
  });

  it("keeps HOME first, then USERPROFILE, then the system's, everywhere else", () => {
    for (const platform of ["linux", "darwin", "freebsd"] as const) {
      onPlatform(platform);
      expect(userHome({ HOME: msys, USERPROFILE: windows }), platform).toBe(msys);
      expect(userHome({ USERPROFILE: windows }), platform).toBe(windows);
      expect(userHome({}), platform).toBe(homedir());
    }
  });
});

describe("what reads the profile folder follows it", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "seira-engine-home-")); });
  afterEach(async () => { await removeTempDir(root); });

  it("puts Claude's account folder under USERPROFILE on Windows, and under HOME elsewhere", () => {
    const shell = join(root, "msys", "home", "me"), profile = join(root, "Users", "me");
    const env = { HOME: shell, USERPROFILE: profile };
    onPlatform("win32");
    expect(resolveClaudeConfigDir(undefined, env)).toBe(join(profile, ".claude"));
    expect(resolveClaudeConfigDir("~/.claude-work", env)).toBe(join(profile, ".claude-work"));
    onPlatform("linux");
    expect(resolveClaudeConfigDir(undefined, env)).toBe(join(shell, ".claude"));
  });

  it("reads Claude's settings from USERPROFILE on Windows", () => {
    const shell = join(root, "msys", "home", "me"), profile = join(root, "Users", "me"), cwd = join(root, "bot");
    mkdirSync(join(profile, ".claude"), { recursive: true });
    mkdirSync(cwd);
    writeFileSync(join(profile, ".claude", "settings.json"), JSON.stringify({ env: { ENABLE_TOOL_SEARCH: "false" } }));
    onPlatform("win32");
    expect(claudeToolSearchSetting(cwd, { HOME: shell, USERPROFILE: profile })).toBe("false");
    onPlatform("linux");
    expect(claudeToolSearchSetting(cwd, { HOME: shell, USERPROFILE: profile }), "elsewhere HOME has no settings, so the default").toBe("true");
  });
});

describe("the server's own code", () => {
  const SERVER = new URL(".", import.meta.url).pathname;
  const sources = (folder: string): string[] =>
    readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "testing" ? [] : sources(path);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
    });
  // HOME first, then USERPROFILE or the system's own: the order that is wrong on Windows.
  const OWN_LOOKUP = /\.HOME\)?\s*(?:\|\||\?\?)\s*(?:\w+\()?(?:[\w.]*\.USERPROFILE|homedir\(\))|\.USERPROFILE\)?\s*(?:\|\||\?\?)\s*(?:\w+\()?[\w.]*\.HOME\b/;

  it("resolves the profile folder only through userHome()", () => {
    const own = sources(SERVER)
      .filter((path) => relative(SERVER, path) !== "env-path.ts")
      .flatMap((path) => readFileSync(path, "utf8").split("\n").map((line, index) => ({ line, at: `${relative(SERVER, path)}:${index + 1}` })))
      .filter(({ line }) => OWN_LOOKUP.test(line) && !line.includes('"win32"')) // a line that already picks by platform is right
      .map(({ at }) => at);
    expect(own).toEqual([]);
  });
});
