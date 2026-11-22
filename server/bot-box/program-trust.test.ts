import { chmodSync, mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { augmentedPath, findCliCandidates, registerPathDir, resetPathCacheForTests } from "../env-path.ts";
import { execCli, spawnCli } from "../procs.ts";
import { BoxRunner } from "./box.ts";
import { distrustHomePrograms, distrustLimitedBoxFolders, homeProgramsDistrusted, programsDistrusted, serverMayRunFrom, serverPath } from "./program-trust.ts";

const posix = process.platform !== "win32";

function plant(dir: string, name: string, marker: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\necho "$0" >> "${marker}"\necho 9.9.9\n`);
  chmodSync(file, 0o755);
  return file;
}

function run(cli: string, env: NodeJS.ProcessEnv): Promise<{ error: (Error & { code?: unknown }) | null; stdout: string }> {
  return new Promise((resolve) => execCli(cli, ["--version"], { env, timeout: 10_000 }, (error, stdout) => resolve({ error, stdout })));
}

afterEach(() => {
  distrustHomePrograms(null);
  distrustLimitedBoxFolders(null);
  resetPathCacheForTests();
});

describe("programs a boxed bot could have written", () => {
  it("are trusted everywhere while the box is off", () => {
    expect(serverMayRunFrom("/data/.local/bin")).toBe(true);
    expect(serverPath("/usr/bin:/data/.local/bin")).toBe("/usr/bin:/data/.local/bin");
  });

  it("while the box is on: nothing under HOME but the data folder, and no relative folder", () => {
    distrustHomePrograms("/data", ["/data/.seira"], ["/data/.seira/workspaces", "/srv/seira/task-workspaces"]);
    expect(serverMayRunFrom("/data/.seira/workspaces/b1/tool")).toBe(false);
    expect(serverMayRunFrom("/srv/seira/task-workspaces/b1/t1/tool")).toBe(false);
    expect(serverMayRunFrom("/data/.local/bin")).toBe(false);
    expect(serverMayRunFrom("/data/.local/bin/pi")).toBe(false);
    expect(serverMayRunFrom("/data")).toBe(false);
    expect(serverMayRunFrom("/data/.seira/tools/npm/bin")).toBe(true);
    expect(serverMayRunFrom("/database/bin")).toBe(true);
    expect(serverMayRunFrom("/usr/local/bin")).toBe(true);
    expect(serverMayRunFrom("bin")).toBe(false);
    expect(serverPath(["/data/.seira/tools/npm/bin", "/usr/local/bin", "/data/.local/bin", "", ".", "/usr/bin", "/data/bin"].join(delimiter)))
      .toBe(["/data/.seira/tools/npm/bin", "/usr/local/bin", "/usr/bin"].join(delimiter));
  });

  it("with only the limited bots boxed: their folders by both names, and nothing else of HOME", () => {
    distrustLimitedBoxFolders(["/data/.grok", "/data/.seira/workspaces"], () => ["/work/project", "relative/bin"]);
    expect(homeProgramsDistrusted()).toBe(false);
    expect(programsDistrusted()).toBe(true);
    expect(serverMayRunFrom("/data/.grok/bin")).toBe(false);
    expect(serverMayRunFrom("/data/.seira/workspaces/b1/tool")).toBe(false);
    expect(serverMayRunFrom("/work/project/node_modules/.bin")).toBe(false);
    expect(serverMayRunFrom("/data")).toBe(true);
    expect(serverMayRunFrom("/data/.local/bin")).toBe(true);
    expect(serverMayRunFrom("/data/.seira/tools/npm/bin")).toBe(true);
    expect(serverMayRunFrom("/work/projects")).toBe(true);
    expect(serverMayRunFrom("bin")).toBe(false);
    expect(serverPath(["/data/.local/bin", "/data/.grok/bin", "", ".", "/usr/bin", "/work/project/bin"].join(delimiter)))
      .toBe(["/data/.local/bin", "/usr/bin"].join(delimiter));
    distrustLimitedBoxFolders(["/data/.grok"], () => { throw new Error("no list"); });
    expect(serverMayRunFrom("/data/.grok/bin"), "a list that fails keeps the folders the box always writes").toBe(false);
    expect(serverMayRunFrom("/work/project/bin")).toBe(true);
    distrustLimitedBoxFolders(null);
    expect(programsDistrusted()).toBe(false);
    expect(serverPath(["/data/.grok/bin", "."].join(delimiter))).toBe(["/data/.grok/bin", "."].join(delimiter));
  });

  it("with only the limited bots boxed: the program folders the box has read-only stay trusted, and the rest of their sign-in folders does not", () => {
    let chosen: string[] = [];
    let kept: () => string[] = () => ["/data/.grok/bin", "/data/.grok/downloads", "/data/.claude/local", "/data/.kimi-code/bin", "relative"];
    distrustLimitedBoxFolders(["/data/.grok", "/data/.claude", "/data/.kimi-code"], () => chosen, () => kept());
    for (const path of ["/data/.grok/bin", "/data/.grok/downloads/grok-1", "/data/.claude/local", "/data/.claude/local/claude", "/data/.kimi-code/bin/kimi"]) expect(serverMayRunFrom(path), path).toBe(true);
    for (const path of ["/data/.grok", "/data/.grok/sessions", "/data/.claude", "/data/.claude/projects/bin", "/data/.kimi-code/cache"]) expect(serverMayRunFrom(path), path).toBe(false);
    expect(serverPath(["/data/.grok/bin", "/data/.grok/sessions", "/data/.claude/local", "/usr/bin"].join(delimiter))).toBe(["/data/.grok/bin", "/data/.claude/local", "/usr/bin"].join(delimiter));
    chosen = ["/data/.grok"];
    expect(serverMayRunFrom("/data/.grok/bin"), "a folder a bot may change wins over a read-only one").toBe(false);
    chosen = [];
    kept = () => { throw new Error("no list"); };
    expect(serverMayRunFrom("/data/.grok/bin"), "a list that fails keeps the whole sign-in folder distrusted").toBe(false);
  });

  it.skipIf(!posix)("a link in a sign-in folder never borrows the trust of the read-only folder it points to", () => {
    const home = mkdtempSync(join(tmpdir(), "seira-kept-link-"));
    try {
      mkdirSync(join(home, ".grok", "bin"), { recursive: true });
      symlinkSync(join(home, ".grok", "bin"), join(home, ".grok", "link"));
      symlinkSync(join(home, ".grok"), join(home, "grok-link"));
      distrustLimitedBoxFolders([join(home, ".grok")], () => [], () => [join(home, ".grok", "bin")]);
      expect(serverMayRunFrom(join(home, ".grok", "link")), "the box can point its own link elsewhere").toBe(false);
      expect(serverMayRunFrom(join(home, "grok-link", "bin")), "a link the box cannot change, to the read-only folder").toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("every bot boxed: HOME is untrusted, as before", () => {
    distrustHomePrograms("/data", ["/data/.seira"]);
    expect(homeProgramsDistrusted()).toBe(true);
    expect(programsDistrusted()).toBe(true);
  });

  it.skipIf(!posix)("with only the limited bots boxed, an unboxed spawn starts no program from their folders, and HOME's still run", async () => {
    const home = homedir();
    const marker = join(home, "ran-limited");
    rmSync(marker, { force: true });
    const planted = plant(join(home, ".grok", "bin"), "seira-planted-grok", marker);
    const own = plant(join(home, ".local", "bin"), "seira-own-cli", marker);
    const env = { ...process.env, PATH: [join(home, ".grok", "bin"), join(home, ".local", "bin"), "/usr/bin", "/bin"].join(delimiter) };
    distrustLimitedBoxFolders([join(home, ".grok")]);

    const byName = await run("seira-planted-grok", env);
    expect((byName.error as NodeJS.ErrnoException | null)?.code).toBe("ENOENT");
    const byPath = await run(planted, env);
    expect((byPath.error as NodeJS.ErrnoException | null)?.code).toBe("EACCES");
    expect(existsSync(marker)).toBe(false);

    const ok = await run("seira-own-cli", env);
    expect(ok.error).toBeNull();
    expect(readFileSync(marker, "utf8").trim()).toBe(own);
  });

  it.skipIf(!posix)("an unboxed spawn checks each link on the way to a program, by path and by name", async () => {
    const home = homedir();
    const marker = join(home, "ran-chain");
    rmSync(marker, { force: true });
    const grok = join(home, ".grok-chain");
    const real = plant(join(grok, "versions", "1.0"), "seira-chain-grok", marker);
    mkdirSync(join(grok, "bin"), { recursive: true });
    mkdirSync(join(grok, "tmp"), { recursive: true });
    symlinkSync(join("..", "versions", "1.0", "seira-chain-grok"), join(grok, "tmp", "link"));
    symlinkSync(join("..", "tmp", "link"), join(grok, "bin", "seira-chain-grok"));
    const env = { ...process.env, PATH: [join(grok, "bin"), "/usr/bin", "/bin"].join(delimiter) };
    let kept = [join(grok, "bin"), join(grok, "versions")];
    distrustLimitedBoxFolders([grok], () => [], () => kept);

    expect(serverMayRunFrom(join(grok, "bin")), "the folder itself is read-only in the box").toBe(true);
    expect(serverMayRunFrom(real)).toBe(true);
    expect(serverMayRunFrom(join(grok, "bin", "seira-chain-grok")), "a link on the way sits in a folder the box writes").toBe(false);
    for (const command of [join(grok, "bin", "seira-chain-grok"), "seira-chain-grok"]) {
      expect(((await run(command, env)).error as NodeJS.ErrnoException | null)?.code, command).toBe("EACCES");
    }
    expect(existsSync(marker)).toBe(false);

    kept = [...kept, join(grok, "tmp")];
    expect((await run("seira-chain-grok", env)).error, "every folder on the way is read-only in the box").toBeNull();
    expect(existsSync(marker)).toBe(true);
    rmSync(grok, { recursive: true, force: true });
  });

  it.skipIf(!posix)("a program in a trusted folder is refused when a link on its way passes a folder the box writes", async () => {
    const home = homedir();
    const marker = join(home, "ran-hop");
    rmSync(marker, { force: true });
    const grok = join(home, ".grok-hop");
    const trusted = join(home, "trusted-hop");
    const real = plant(join(trusted, "real"), "seira-hop-real", marker);
    const writable = plant(join(grok, "sessions"), "seira-hop-written", marker);
    mkdirSync(join(trusted, "bin"), { recursive: true });
    symlinkSync(writable, join(trusted, "bin", "seira-hop-into"));
    symlinkSync(real, join(grok, "sessions", "hop"));
    symlinkSync(join(grok, "sessions", "hop"), join(trusted, "bin", "seira-hop-through"));
    const env = { ...process.env, PATH: [join(trusted, "bin"), "/usr/bin", "/bin"].join(delimiter) };
    distrustLimitedBoxFolders([grok]);

    expect(serverMayRunFrom(real)).toBe(true);
    for (const name of ["seira-hop-into", "seira-hop-through"]) {
      expect(serverMayRunFrom(join(trusted, "bin", name)), name).toBe(false);
      for (const command of [join(trusted, "bin", name), name]) {
        expect(((await run(command, env)).error as NodeJS.ErrnoException | null)?.code, command).toBe("EACCES");
      }
    }
    expect(existsSync(marker)).toBe(false);
    rmSync(grok, { recursive: true, force: true });
    rmSync(trusted, { recursive: true, force: true });
  });

  it.skipIf(!posix)("every bot boxed: a program in the data folder is refused when a link on its way passes HOME", async () => {
    const home = homedir();
    const dataDir = join(home, ".seira");
    const marker = join(home, "ran-data-hop");
    rmSync(marker, { force: true });
    const appBin = join(dataDir, "tools", "npm", "bin");
    const real = plant(join(dataDir, "tools", "npm", "lib"), "seira-data-real", marker);
    mkdirSync(join(home, ".local", "hop"), { recursive: true });
    mkdirSync(appBin, { recursive: true });
    const hop = join(home, ".local", "hop", "seira-data-real");
    rmSync(hop, { force: true });
    symlinkSync(real, hop);
    const linked = join(appBin, "seira-data-hop");
    rmSync(linked, { force: true });
    symlinkSync(hop, linked);
    const env = { ...process.env, PATH: [appBin, "/usr/bin", "/bin"].join(delimiter) };
    distrustHomePrograms(home, [dataDir]);

    expect(serverMayRunFrom(real)).toBe(true);
    expect(serverMayRunFrom(linked)).toBe(false);
    for (const command of [linked, "seira-data-hop"]) {
      expect(((await run(command, env)).error as NodeJS.ErrnoException | null)?.code, command).toBe("EACCES");
    }
    expect(existsSync(marker)).toBe(false);

    const homeLink = join(mkdtempSync(join(tmpdir(), "seira-home-link-")), "home");
    symlinkSync(home, homeLink);
    distrustHomePrograms(homeLink, [join(homeLink, ".seira")]);
    expect(serverMayRunFrom(join(homeLink, ".seira", "tools", "npm", "lib", "seira-data-real")), "HOME is a link no bot can change").toBe(true);
    expect(serverMayRunFrom(join(homeLink, ".local", "hop", "seira-data-real"))).toBe(false);
    expect(serverMayRunFrom(linked)).toBe(false);
    rmSync(dirname(homeLink), { recursive: true, force: true });
  });

  it.skipIf(!posix)("judges a `..` after a link from where the link leads, as the system does", async () => {
    const home = homedir();
    const marker = join(home, "ran-dotdot");
    rmSync(marker, { force: true });
    const grok = join(home, ".grok-dotdot");
    const safe = join(home, "safe-dotdot");
    plant(safe, "seira-dotdot", marker);
    plant(join(grok, "sessions"), "seira-dotdot", join(home, "ran-dotdot-written"));
    rmSync(join(home, "ran-dotdot-written"), { force: true });
    mkdirSync(join(grok, "sessions", "sub"), { recursive: true });
    symlinkSync(join(grok, "sessions", "sub"), join(safe, "link"));
    const command = `${safe}/link/../seira-dotdot`;
    distrustLimitedBoxFolders([grok]);

    expect(serverMayRunFrom(join(safe, "seira-dotdot"))).toBe(true);
    expect(serverMayRunFrom(command)).toBe(false);
    expect(((await run(command, process.env)).error as NodeJS.ErrnoException | null)?.code).toBe("EACCES");
    expect(existsSync(marker) || existsSync(join(home, "ran-dotdot-written"))).toBe(false);

    distrustLimitedBoxFolders(null);
    expect((await run(command, process.env)).error).toBeNull();
    expect(existsSync(join(home, "ran-dotdot-written")), "the system runs the one the link leads to").toBe(true);
    expect(existsSync(marker)).toBe(false);
    rmSync(grok, { recursive: true, force: true });
    rmSync(safe, { recursive: true, force: true });
  });

  it.skipIf(!posix)("looks a program up in a PATH folder with a `..` after a link as the system does", async () => {
    const home = homedir();
    const marker = join(home, "ran-path-dotdot");
    rmSync(marker, { force: true });
    const grok = join(home, ".grok-path-dotdot");
    const trusted = join(home, "trusted-path-dotdot");
    const other = join(home, "other-path-dotdot");
    const written = plant(join(grok, "sessions"), "seira-path-dotdot", marker);
    mkdirSync(join(grok, "sessions", "sub"), { recursive: true });
    mkdirSync(join(other, "sub"), { recursive: true });
    mkdirSync(trusted, { recursive: true });
    symlinkSync(written, join(other, "seira-path-dotdot"));
    symlinkSync(join(other, "sub"), join(trusted, "link"));
    symlinkSync(join(grok, "sessions", "sub"), join(trusted, "link-written"));
    const entry = `${trusted}/link/..`;
    const env = { ...process.env, PATH: [entry, "/usr/bin", "/bin"].join(delimiter) };
    distrustLimitedBoxFolders([grok]);

    expect(serverPath(env.PATH).split(delimiter)).toContain(entry);
    expect(serverPath(`${trusted}/link-written/..`), "the folder it ends at is written by the box").toBe("");
    expect(((await run("seira-path-dotdot", env)).error as NodeJS.ErrnoException | null)?.code).toBe("EACCES");
    expect(existsSync(marker)).toBe(false);

    distrustLimitedBoxFolders(null);
    expect((await run("seira-path-dotdot", env)).error, "the system finds the one the link leads to").toBeNull();
    expect(existsSync(marker)).toBe(true);
    rmSync(grok, { recursive: true, force: true });
    rmSync(trusted, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  it.skipIf(!posix)("the server's PATH keeps the app's own engines and the system's, never HOME's program folders", () => {
    const home = homedir();
    const dataDir = join(home, ".seira");
    const marker = join(home, "ran");
    plant(join(home, ".local", "bin"), "seira-planted-engine", marker);
    plant(join(home, ".opencode", "bin"), "seira-planted-engine-2", marker);
    const appBin = join(dataDir, "tools", "npm", "bin");
    plant(appBin, "seira-app-engine", marker);
    registerPathDir(appBin);
    expect(findCliCandidates("seira-planted-engine")).toHaveLength(1);

    distrustHomePrograms(home, [dataDir]);
    resetPathCacheForTests();
    registerPathDir(appBin);
    const parts = augmentedPath().split(delimiter);
    expect(parts).toContain(appBin);
    expect(parts.some((dir) => dir === join(home, ".local", "bin") || dir === join(home, ".opencode", "bin"))).toBe(false);
    expect(findCliCandidates("seira-planted-engine")).toEqual([]);
    expect(findCliCandidates("seira-planted-engine-2")).toEqual([]);
    expect(findCliCandidates("seira-app-engine")).toEqual([join(appBin, "seira-app-engine")]);
  });

  it.skipIf(!posix)("an unboxed spawn neither finds a program in HOME on the PATH it is given nor starts one by its path", async () => {
    const home = homedir();
    const dataDir = join(home, ".seira");
    const marker = join(home, "ran-spawn");
    rmSync(marker, { force: true });
    const planted = plant(join(home, ".local", "bin"), "seira-planted-cli", marker);
    const appCli = plant(join(dataDir, "tools", "npm", "bin"), "seira-app-cli", marker);
    const linked = join(dataDir, "tools", "npm", "bin", "seira-linked-cli");
    rmSync(linked, { force: true });
    (await import("node:fs")).symlinkSync(planted, linked);
    const env = { ...process.env, PATH: [join(home, ".local", "bin"), join(dataDir, "tools", "npm", "bin"), "/usr/bin", "/bin"].join(delimiter) };
    distrustHomePrograms(home, [dataDir]);

    const byName = await run("seira-planted-cli", env);
    expect((byName.error as NodeJS.ErrnoException | null)?.code).toBe("ENOENT");
    const byPath = await run(planted, env);
    expect((byPath.error as NodeJS.ErrnoException | null)?.code).toBe("EACCES");
    const byLink = await run(linked, env);
    expect((byLink.error as NodeJS.ErrnoException | null)?.code).toBe("EACCES");
    expect(() => spawnCli(planted, ["--version"], { env, stdio: ["pipe", "pipe", "pipe"] })).toThrow(/bots can write/);
    expect(existsSync(marker)).toBe(false);

    const app = await run("seira-app-cli", env);
    expect(app.error).toBeNull();
    expect(app.stdout.trim()).toBe("9.9.9");
    expect(readFileSync(marker, "utf8").trim()).toBe(appCli);

    distrustHomePrograms(null);
    const before = await run("seira-planted-cli", env);
    expect(before.error).toBeNull();
  });

  it.skipIf(!posix)("a boxed process keeps HOME's program folders on its own PATH, after the server's", () => {
    const home = homedir();
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const runner = new BoxRunner({
      bwrap: "/usr/bin/bwrap", bridge: { socat: null, bridgeScript: "/x/bridge.js", node: "/usr/bin/node" },
      setup: { dataDir: join(home, ".seira"), home, codeRoots: [], engineRoots: [], bridges: [] }, denyEnv: new Set(),
    });
    distrustHomePrograms(home, [join(home, ".seira")]);
    const wrapped = runner.wrap({ command: "/usr/bin/true", args: [], env: { PATH: "/usr/bin:/bin", HOME: home }, net: "shared" });
    const path = wrapped.env.PATH!.split(delimiter);
    expect(path.slice(0, 2)).toEqual(["/usr/bin", "/bin"]);
    expect(path).toContain(join(home, ".local", "bin"));
  });
});
