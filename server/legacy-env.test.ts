import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boxEnvironment, boxEnvironmentAllows } from "./bot-box/env.ts";
import { stripControlPlaneEnv, stripWorkspaceCredentialEnv, stripWorkspaceCredentialKeys } from "./credential-env.ts";
import { isHarnessOwnedMcpEnvName } from "./mcp-registry.ts";

const fixtures: string[] = [];
const fixture = (prefix: string): string => { const folder = mkdtempSync(join(tmpdir(), prefix)); fixtures.push(folder); return folder; };
afterEach(() => { while (fixtures.length) rmSync(fixtures.pop()!, { recursive: true, force: true }); });

function dataDirOf(env: Record<string, string>): { dir: string; stderr: string } {
  const home = fixture("seira-env-home-");
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
    `const { DATA_DIR } = await import("./server/config.ts"); process.stdout.write(DATA_DIR);`], {
    cwd: join(import.meta.dirname, ".."), encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, ...env },
  });
  return { dir: run.stdout, stderr: run.stderr };
}

describe("the data folder variable", () => {
  it("SEIRA_DATA_DIR is the data folder", () => {
    const folder = fixture("seira-env-data-");
    const { dir, stderr } = dataDirOf({ SEIRA_DATA_DIR: folder });
    expect(dir).toBe(folder);
    expect(stderr).not.toContain("deprecated");
  });

  it("OMB_DATA_DIR still is, with a deprecation warning that leaves out the path", () => {
    const folder = fixture("seira-env-data-");
    const { dir, stderr } = dataDirOf({ OMB_DATA_DIR: folder });
    expect(dir).toBe(folder);
    expect(stderr).toContain("OMB_DATA_DIR is deprecated");
    expect(stderr).not.toContain(folder);
  });

  it("SEIRA_DATA_DIR wins when both are set, and says so", () => {
    const current = fixture("seira-env-current-");
    const old = fixture("seira-env-old-");
    const { dir, stderr } = dataDirOf({ SEIRA_DATA_DIR: current, OMB_DATA_DIR: old });
    expect(dir).toBe(current);
    expect(stderr).toContain("using SEIRA_DATA_DIR");
  });
});

describe("variables the harness keeps for itself, under either prefix", () => {
  const names = ["SEIRA_OPENAI_API_KEY", "OMB_OPENAI_API_KEY", "SEIRA_JEV_API_KEY", "OMB_JEV_API_KEY", "SEIRA_CONTROL_TOKEN", "OMB_CONTROL_TOKEN"];

  it("never reach a custom MCP server", () => {
    for (const name of names) expect(isHarnessOwnedMcpEnvName(name), name).toBe(true);
  });

  it("never reach a box, even when a spawn vouches for the name", () => {
    for (const name of names.filter((name) => name.startsWith("OMB_"))) {
      expect(boxEnvironmentAllows(name, new Set(), new Set([name])), name).toBe(false);
    }
    const kept = Object.keys(boxEnvironment(Object.fromEntries(names.map((name) => [name, "fixture-value"]))));
    expect(kept.filter((name) => name.startsWith("OMB_"))).toEqual([]);
    expect(kept).not.toContain("SEIRA_OPENAI_API_KEY");
    expect(kept).not.toContain("SEIRA_JEV_API_KEY");
  });

  it("are stripped from an engine's environment", () => {
    const env: Record<string, string | undefined> = {
      SEIRA_OPENAI_API_KEY: "a", OMB_OPENAI_API_KEY: "b", SEIRA_JEV_API_KEY: "c", OMB_JEV_API_KEY: "d",
      SEIRA_LICENSE_KEY: "e", OMB_LICENSE_KEY: "f", SEIRA_CLOUD_ROLE: "g", OMB_CLOUD_ROLE: "h", PATH: "/bin",
    };
    stripWorkspaceCredentialEnv(env);
    expect(env).toEqual({ PATH: "/bin" });
    const kept: Record<string, string | undefined> = { SEIRA_OPENAI_API_KEY: "a", OMB_OPENAI_API_KEY: "b", SEIRA_JEV_API_KEY: "c", OMB_JEV_API_KEY: "d" };
    stripWorkspaceCredentialKeys(kept, new Set(["SEIRA_OPENAI_API_KEY"]));
    expect(kept).toEqual({ SEIRA_OPENAI_API_KEY: "a" });
    const control: Record<string, string | undefined> = { OMB_CLOUD_BOAT_URL: "x", OMB_INSTALLATION_CREDENTIAL: "y", HOME: "/h" };
    stripControlPlaneEnv(control);
    expect(control).toEqual({ HOME: "/h" });
  });
});
