import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boxEnvironment, boxEnvironmentAllows } from "./bot-box/env.ts";
import { stripControlPlaneEnv, stripWorkspaceCredentialEnv, stripWorkspaceCredentialKeys } from "./credential-env.ts";
import { chatMcpEnvironment } from "./drivers/chat-mcp-tools.ts";
import { probeEnvironment } from "./mcp-probe.ts";
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

describe("names in mixed case, as a Windows environment can hold them", () => {
  const mixed = ["Omb_OPENAI_API_KEY", "omb_jev_api_key", "Seira_OPENAI_API_KEY", "seira_jev_api_key", "Omb_Control_Token"];

  it("are stripped from an engine's environment", () => {
    const env: Record<string, string | undefined> = { ...Object.fromEntries(mixed.filter((name) => !/control_token/i.test(name)).map((name) => [name, "fixture-value"])), Omb_License_Key: "x", PATH: "/bin" };
    stripWorkspaceCredentialEnv(env);
    expect(env).toEqual({ PATH: "/bin" });
  });

  it("are refused as MCP server names", () => {
    for (const name of mixed) expect(isHarnessOwnedMcpEnvName(name), name).toBe(true);
  });

  it("never reach a box, even when a spawn vouches for the name", () => {
    const fixture = Object.fromEntries(mixed.map((name) => [name, "fixture-value"]));
    expect(boxEnvironment(fixture, new Set(), new Set(mixed))).toEqual({});
    for (const name of mixed) expect(boxEnvironmentAllows(name, new Set(), new Set([name])), name).toBe(false);
  });

  it("a lower-case spelling of a denied name stays denied", () => {
    expect(boxEnvironmentAllows("xai_api_key", new Set(["XAI_API_KEY"]), new Set())).toBe(false);
  });
});

describe("a chat tool server's environment", () => {
  it("carries no workspace key under either prefix, and keeps the entry's own", () => {
    const source = { SEIRA_OPENAI_API_KEY: "a", OMB_OPENAI_API_KEY: "b", Omb_Jev_Api_Key: "c", HOME: "/h" };
    const env = chatMcpEnvironment({ OWN_TOKEN: "mine" }, source);
    expect(Object.keys(env).filter((name) => /openai|jev/i.test(name))).toEqual([]);
    expect(env.HOME).toBe("/h");
    expect(env.OWN_TOKEN).toBe("mine");
  });

  it("and a connection test's, drop the operator's mail and session names and provider keys in any case, under either prefix", () => {
    const source = {
      SEIRA_SIGNIN_SMTP_URL: "a", OMB_SIGNIN_SMTP_URL: "b", Seira_Signin_Smtp_Url: "c", SEIRA_TOKEN: "d", Omb_Token: "e", seira_token: "f",
      ANTHROPIC_API_KEY: "g", Anthropic_Api_Key: "h", HOME: "/h",
    };
    for (const env of [chatMcpEnvironment({ OWN_TOKEN: "mine" }, source), probeEnvironment({ env: { OWN_TOKEN: "mine" } }, source)]) {
      expect(Object.keys(env).filter((name) => /smtp|token|anthropic/i.test(name))).toEqual(["OWN_TOKEN"]);
      expect(env.HOME).toBe("/h");
      expect(env.OWN_TOKEN).toBe("mine");
    }
  });

  it("lets the entry's own env name one of those variables, applied after the filter", () => {
    const source = { SEIRA_TOKEN: "operator", ANTHROPIC_API_KEY: "operator" };
    const entry = { SEIRA_TOKEN: "entry", ANTHROPIC_API_KEY: "entry" };
    expect(chatMcpEnvironment(entry, source)).toMatchObject(entry);
    expect(probeEnvironment({ env: entry }, source)).toMatchObject(entry);
  });
});

describe("the launchers", () => {
  function launcher(script: string, env: Record<string, string>): { out: unknown; stderr: string } {
    const home = fixture("seira-env-home-");
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      cwd: join(import.meta.dirname, ".."), encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, ...env },
    });
    return { out: run.stdout ? JSON.parse(run.stdout) : run.stderr, stderr: run.stderr };
  }

  it("the container launcher given only OMB_DATA_DIR keeps its compile cache and its server child on that folder", () => {
    const folder = fixture("seira-env-data-");
    const { out, stderr } = launcher(
      `const { serverCommand } = await import("./server/server-launcher.ts");
       const run = serverCommand("/app", process.env, { exists: () => true, box: { bytes: 1, cgroupLimit: null } });
       process.stdout.write(JSON.stringify({ cache: run.env.SEIRA_SERVER_COMPILE_CACHE, data: run.env.SEIRA_DATA_DIR, old: Object.keys(run.env).filter((name) => /^omb_/i.test(name)) }));`,
      { OMB_DATA_DIR: folder });
    expect(out).toEqual({ cache: join(folder, "cache", "node-compile"), data: folder, old: [] });
    expect(stderr).toContain("OMB_DATA_DIR is deprecated");
  });

  it("the Cloud home launcher given only OMB_DATA_DIR puts the server's data folder there", () => {
    const folder = fixture("seira-env-data-");
    const { out } = launcher(
      `const start = await import("./server/cloud-home-start.ts");
       process.stdout.write(JSON.stringify({ dir: start.cloudHomeDataDir(process.env, "/data"), old: Object.keys(process.env).filter((name) => /^omb_/i.test(name)) }));`,
      { OMB_DATA_DIR: folder });
    expect(out).toEqual({ dir: folder, old: [] });
  });
});
