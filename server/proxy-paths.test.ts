import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { APP_EXECUTION_ALIAS } from "../scripts/appx-manifest.mjs";
import { ownNodeCommand, SERVER_ROOT, SPAWNED_PROXIES, STORE_ALIAS } from "./proxy-paths.ts";

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
    expect(STORE_ALIAS).toBe(APP_EXECUTION_ALIAS);
  });

  it("starts a Store package through the alias in its package family folder", () => {
    expect(ownNodeCommand(STORE_EXE, env, () => true)).toBe(FAMILY_ALIAS);
  });

  it("uses the alias on the PATH folder when the family folder has none", () => {
    expect(ownNodeCommand(STORE_EXE, env, (path) => path === GLOBAL_ALIAS)).toBe(GLOBAL_ALIAS);
  });

  it("keeps the executable when the package has no alias", () => {
    expect(ownNodeCommand(STORE_EXE, env, () => false)).toBe(STORE_EXE);
    expect(ownNodeCommand(STORE_EXE, {}, () => true)).toBe(STORE_EXE);
  });

  it.each([
    "C:\\Users\\pat\\AppData\\Local\\Programs\\Seira\\Seira.exe",
    "/opt/Seira/seira",
    "/usr/bin/node",
  ])("keeps %s, which any program may start", (execPath) => {
    expect(ownNodeCommand(execPath, env, () => true)).toBe(execPath);
  });
});
