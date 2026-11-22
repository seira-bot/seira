import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "./cli.ts";
import { migrateBeforeFirstWrite } from "./cli-data-move.ts";
import { dataHome } from "./data-dir.ts";

const mocks = vi.hoisted(() => ({
  fleetCredential: vi.fn(() => null),
  FLEET_CREDENTIAL_ENV: "SEIRA_INSTALLATION_CREDENTIAL",
  spawn: vi.fn(),
  tailscaleStatus: vi.fn(), tailscaleServe: vi.fn(), tailscaleStop: vi.fn(), clearLeftoverTailscaleServe: vi.fn(), tailnetListenFallback: vi.fn(),
  createTunnelAccount: vi.fn(), describeTunnelAccount: vi.fn(),
}));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), spawn: mocks.spawn,
}));
vi.mock("./tailscale.ts", () => ({
  pickTailscaleHttpsPort: () => ({ port: 443, line: null }), tailscaleHttpsProblem: async () => null,
  tailscaleStatus: mocks.tailscaleStatus, tailscaleServe: mocks.tailscaleServe, tailnetListenFallback: mocks.tailnetListenFallback,
  clearLeftoverTailscaleServe: mocks.clearLeftoverTailscaleServe, explainTailscaleFailure: (failure: string) => failure,
}));
vi.mock("./tunnel.ts", () => ({ ...mocks, describeTunnelState: () => "Fixture tunnel" }));
vi.mock("./browser-engine.ts", () => ({
  browserEngineStatus: () => ({ kind: "ready" }), describeBrowserEngine: () => "Fixture browser ready",
}));

const MARKER = "tailscale-serve.marker";
let home: string;
let oldFolder: string;
let newFolder: string;

function botOnlyMessages(dir: string): void {
  const db = new DatabaseSync(join(dir, "messages.db"));
  db.exec("CREATE TABLE messages (thread_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT, json TEXT NOT NULL)");
  db.prepare("INSERT INTO messages VALUES ('welcome', 'm1', 1, 'bot', 'options', NULL, '{}')").run();
  db.close();
}

beforeEach(() => {
  vi.stubEnv("SEIRA_DATA_DIR", "");
  home = dataHome();
  expect(home).toBe(homedir());
  oldFolder = join(home, ".openmausbot");
  newFolder = join(home, ".seira");
  mkdirSync(oldFolder);
  writeFileSync(join(oldFolder, "config.json"), `{"fixture":"old"}`);
  writeFileSync(join(oldFolder, "bots.json"), "[]");
  mkdirSync(newFolder);
  writeFileSync(join(newFolder, MARKER), `{"fixture":"stale"}`);
  mocks.tailscaleStatus.mockResolvedValue({ status: { cli: "/fixture/tailscale", dnsName: "fixture.tail.test", addresses: [], backendState: "Running" } });
  mocks.tailscaleServe.mockImplementation(async (_status: unknown, _port: number, { dataDir }: { dataDir: string }) => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, MARKER), `{"fixture":"fresh"}`);
    return { origin: "https://fixture.tail.test", stop: mocks.tailscaleStop };
  });
  mocks.tailscaleStop.mockResolvedValue(undefined);
  mocks.clearLeftoverTailscaleServe.mockResolvedValue(false);
  mocks.createTunnelAccount.mockReturnValue({ credentials: { status: "available", read: () => ({}) } });
  mocks.describeTunnelAccount.mockReturnValue({});
  mocks.spawn.mockImplementation(() => { throw new Error("Fixture spawn failure"); });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({}, { status: 503 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  for (const dir of [oldFolder, newFolder]) rmSync(dir, { recursive: true, force: true });
});

describe("seira serve --tailscale after an update from the old folder name", () => {
  it.each([
    { start: "a new folder with only the Tailscale marker", extra: () => undefined },
    { start: "a new folder that a server set up with a default bot and its welcome", extra: () => { writeFileSync(join(newFolder, "bots.json"), "[]"); botOnlyMessages(newFolder); } },
  ])("moves the old data in before its first write, from $start", async ({ extra }) => {
    extra();
    await expect(main(["serve", "--tailscale", "--port", "18452", "--no-pair"])).rejects.toThrow("Fixture spawn failure");
    expect(readFileSync(join(newFolder, "config.json"), "utf8")).toBe(`{"fixture":"old"}`);
    expect(readFileSync(join(newFolder, MARKER), "utf8")).toBe(`{"fixture":"fresh"}`);
    expect(existsSync(oldFolder)).toBe(false);
    const aside = readdirSync(join(newFolder, ".backups")).filter((name) => name.startsWith("seira-before-move-"));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(newFolder, ".backups", aside[0]!, MARKER), "utf8")).toBe(`{"fixture":"stale"}`);
    expect(mocks.spawn.mock.calls[0]?.[2]?.env?.SEIRA_DATA_DIR).toBe(newFolder);
  });

  it("leaves both folders when a person wrote in the new one", async () => {
    botOnlyMessages(newFolder);
    const db = new DatabaseSync(join(newFolder, "messages.db"));
    db.prepare("INSERT INTO messages VALUES ('welcome', 'm2', 2, 'user', 'text', 'hi', '{}')").run();
    db.close();
    migrateBeforeFirstWrite(["serve"]);
    expect(readFileSync(join(oldFolder, "config.json"), "utf8")).toBe(`{"fixture":"old"}`);
    expect(existsSync(join(newFolder, "config.json"))).toBe(false);
  });

  it.each([
    { name: "SEIRA_DATA_DIR", argv: () => [], env: () => ({ SEIRA_DATA_DIR: join(home, "elsewhere") }) },
    { name: "--data-dir", argv: () => ["serve", "--data-dir", join(home, "elsewhere")], env: () => ({}) },
  ])("changes nothing while $name names another folder", ({ argv, env }) => {
    migrateBeforeFirstWrite(argv(), env());
    expect(readFileSync(join(oldFolder, "config.json"), "utf8")).toBe(`{"fixture":"old"}`);
    expect(readdirSync(newFolder)).toEqual([MARKER]);
  });
});
