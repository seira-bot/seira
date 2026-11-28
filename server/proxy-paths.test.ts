import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { aliasTarget, isOwnNode, ownNode, SERVER_ROOT, SPAWNED_PROXIES, STORE_ALIAS } from "./proxy-paths.ts";

describe("local computer proxy runtime path", () => {
  it("resolves an existing TypeScript entry in development", () => {
    expect(SPAWNED_PROXIES.localComputer).toBe(join(SERVER_ROOT, "local-computer-proxy.ts"));
    expect(existsSync(SPAWNED_PROXIES.localComputer)).toBe(true);
  });

  it("is included in the server bundle entry points", () => {
    const script = readFileSync(join(SERVER_ROOT, "../scripts/bundle-server.mjs"), "utf8");
    const entryPoints = script.match(/const ENTRY_POINTS = \[([\s\S]*?)\];/)?.[1];
    expect(entryPoints).toMatch(/["']local-computer-proxy\.ts["']/);
  });

  it("resolves the bundled JavaScript sibling without a source tree", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "seira-proxy-paths-")));
    try {
      await build({
        entryPoints: ["proxy-paths.ts", "local-computer-proxy.ts"].map((entry) => join(SERVER_ROOT, entry)),
        bundle: true,
        platform: "node",
        target: "node20",
        format: "esm",
        outdir: directory,
        logLevel: "silent",
      });
      const manifest = pathToFileURL(join(directory, "proxy-paths.js")).href;
      const output = execFileSync(process.execPath, ["--input-type=module", "-e", [
        `import { SERVER_ROOT, SPAWNED_PROXIES } from ${JSON.stringify(manifest)};`,
        "console.log(JSON.stringify({ root: SERVER_ROOT, localComputer: SPAWNED_PROXIES.localComputer }));",
      ].join("\n")], { encoding: "utf8", timeout: 10_000 });
      const packaged = JSON.parse(output);

      expect(packaged.root).toBe(directory);
      expect(packaged.localComputer).toBe(join(directory, "local-computer-proxy.js"));
      expect(existsSync(packaged.localComputer)).toBe(true);
      expect(existsSync(join(directory, "local-computer-proxy.ts"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("harness MCP proxy runtime path", () => {
  it("ships the one proxy the built-in browser and the cloud computer share", () => {
    expect(SPAWNED_PROXIES.harnessMcp).toBe(join(SERVER_ROOT, "harness-mcp-proxy.ts"));
    expect(existsSync(SPAWNED_PROXIES.harnessMcp)).toBe(true);
    const script = readFileSync(join(SERVER_ROOT, "../scripts/bundle-server.mjs"), "utf8");
    const entryPoints = script.match(/const ENTRY_POINTS = \[([\s\S]*?)\];/)?.[1];
    expect(entryPoints).toMatch(/["']harness-mcp-proxy\.ts["']/);
    expect(entryPoints).not.toMatch(/["']browser-proxy\.ts["']/);
  });
});

describe("the program that runs Seira's scripts for an engine", () => {
  const STORE_EXE = "C:\\Program Files\\WindowsApps\\PTGLOBALRAYAORISWIJAYA.Seira_1.1.195.0_x64__abcdefghjk123\\app\\Seira.exe";
  const env = { LOCALAPPDATA: "C:\\Users\\pat\\AppData\\Local" };
  const FAMILY_ALIAS = "C:\\Users\\pat\\AppData\\Local\\Microsoft\\WindowsApps\\PTGLOBALRAYAORISWIJAYA.Seira_abcdefghjk123\\seira-desktop.exe";
  const GLOBAL_ALIAS = "C:\\Users\\pat\\AppData\\Local\\Microsoft\\WindowsApps\\seira-desktop.exe";

  it("names the alias the Store manifest declares", () => {
    const manifest = readFileSync(join(SERVER_ROOT, "../scripts/appx-manifest.mjs"), "utf8");
    expect(manifest).toContain(`export const APP_EXECUTION_ALIAS = ${JSON.stringify(STORE_ALIAS)};`);
  });

  it("starts a Store package through the alias in its package family folder", () => {
    expect(ownNode(STORE_EXE, env, (path) => (path === FAMILY_ALIAS ? STORE_EXE : null))).toBe(FAMILY_ALIAS);
  });

  it("matches the alias target without regard to letter case", () => {
    expect(ownNode(STORE_EXE, env, () => STORE_EXE.toLowerCase())).toBe(FAMILY_ALIAS);
  });

  it("keeps the executable when the alias leads to another program", () => {
    expect(ownNode(STORE_EXE, env, () => "C:\\Users\\pat\\AppData\\Local\\Temp\\other.exe")).toBe(STORE_EXE);
    expect(ownNode(STORE_EXE, env, () => STORE_EXE.replace("1.1.195.0", "1.1.194.0"))).toBe(STORE_EXE);
  });

  it("keeps the executable when the package has no alias", () => {
    expect(ownNode(STORE_EXE, env, () => null)).toBe(STORE_EXE);
    expect(ownNode(STORE_EXE, {}, () => STORE_EXE)).toBe(STORE_EXE);
  });

  it("never uses the alias folder on the PATH, which any package or program may fill", () => {
    const asked: string[] = [];
    ownNode(STORE_EXE, env, (path) => (asked.push(path), null));
    expect(asked).toEqual([FAMILY_ALIAS]);
    expect(asked).not.toContain(GLOBAL_ALIAS);
  });

  it("reads the alias again for each launch, so an alias changed later is not used", () => {
    let leadsTo = STORE_EXE;
    const target = () => leadsTo;
    expect(ownNode(STORE_EXE, env, target)).toBe(FAMILY_ALIAS);
    leadsTo = "C:\\Users\\pat\\AppData\\Local\\Temp\\other.exe";
    expect(ownNode(STORE_EXE, env, target)).toBe(STORE_EXE);
  });

  it("is computed when a launch is built, never kept in a module constant", () => {
    const kept = /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*ownNode\(/m;
    const offenders = readdirSync(SERVER_ROOT, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts") && !file.includes("node_modules"))
      .filter((file) => kept.test(readFileSync(join(SERVER_ROOT, file), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("knows its own commands by the executable and by the alias path", () => {
    expect(isOwnNode(STORE_EXE, STORE_EXE, env)).toBe(true);
    expect(isOwnNode(FAMILY_ALIAS, STORE_EXE, env)).toBe(true);
    expect(isOwnNode(GLOBAL_ALIAS, STORE_EXE, env)).toBe(false);
    expect(isOwnNode("C:\\Windows\\System32\\cmd.exe", STORE_EXE, env)).toBe(false);
  });

  it("reads the target of a link", () => {
    const folder = mkdtempSync(join(tmpdir(), "seira-alias-"));
    try {
      writeFileSync(join(folder, "Seira.exe"), "");
      symlinkSync(join(folder, "Seira.exe"), join(folder, STORE_ALIAS));
      expect(aliasTarget(join(folder, STORE_ALIAS))).toBe(join(folder, "Seira.exe"));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("reads no target for a plain file", () => {
    const folder = mkdtempSync(join(tmpdir(), "seira-alias-"));
    try {
      writeFileSync(join(folder, STORE_ALIAS), "");
      expect(aliasTarget(join(folder, STORE_ALIAS))).toBeNull();
      expect(aliasTarget(join(folder, "missing.exe"))).toBeNull();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it.each([
    "C:\\Users\\pat\\AppData\\Local\\Programs\\Seira\\Seira.exe",
    "/opt/Seira/seira",
    "/usr/bin/node",
  ])("keeps %s, which any program may start", (execPath) => {
    expect(ownNode(execPath, env, () => execPath)).toBe(execPath);
  });
});
