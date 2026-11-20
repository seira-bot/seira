import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFreeEngineInstaller, freeEngineDecision, freeEngineInstallEnabled, type FreeEngineCandidate, type FreeEngineDeps } from "./free-engine.ts";

const engine = (over: Partial<FreeEngineCandidate> = {}): FreeEngineCandidate => ({
  instanceId: "opencodeGo", driverKind: "opencodeGo", snapshot: { state: "unavailable" },
  install: { server: { standalone: {} } }, cliCandidates: [], ...over,
});
const claude = (ready: boolean): FreeEngineCandidate => ({ instanceId: "claude", driverKind: "claudeAgent", snapshot: { state: ready ? "available" : "unavailable" } });
const isReady = (instance: FreeEngineCandidate) => instance.snapshot.state === "available";
const never = () => false;

describe("freeEngineInstallEnabled", () => {
  it("is on outside tests, off for 0, and on in tests only for 1", () => {
    expect(freeEngineInstallEnabled({})).toBe(true);
    expect(freeEngineInstallEnabled({ SEIRA_FREE_ENGINE: "0" })).toBe(false);
    expect(freeEngineInstallEnabled({ VITEST: "true" })).toBe(false);
    expect(freeEngineInstallEnabled({ SEIRA_TEST_SEALED_PATH: "1" })).toBe(false);
    expect(freeEngineInstallEnabled({ VITEST: "true", SEIRA_FREE_ENGINE: "1" })).toBe(true);
    expect(freeEngineInstallEnabled({ VITEST: "true", SEIRA_FREE_ENGINE: "0" })).toBe(false);
  });
});

describe("freeEngineDecision", () => {
  it("skips when an AI is ready", () => {
    expect(freeEngineDecision([claude(true), engine()], isReady, never)).toEqual({ skip: "ai-ready" });
  });
  it("counts an AI that is ready only through the free models as no AI", () => {
    const free = engine({ snapshot: { state: "available", freeFallback: true } });
    expect(freeEngineDecision([claude(false), free], isReady, never)).toEqual({ skip: "opencode-present" });
  });
  it("skips when OpenCode is present by state or by CLI candidates", () => {
    expect(freeEngineDecision([engine({ snapshot: { state: "available" } })], () => false, never)).toEqual({ skip: "opencode-present" });
    expect(freeEngineDecision([engine({ cliCandidates: ["/usr/bin/opencode"] })], () => false, never)).toEqual({ skip: "opencode-present" });
  });
  it("skips when policy refuses OpenCode", () => {
    expect(freeEngineDecision([engine()], () => false, () => true)).toEqual({ skip: "refused" });
  });
  it("skips when OpenCode is missing or has no install route", () => {
    expect(freeEngineDecision([claude(false)], isReady, never)).toEqual({ skip: "not-installable" });
    expect(freeEngineDecision([engine({ install: { server: {} } })], isReady, never)).toEqual({ skip: "not-installable" });
    expect(freeEngineDecision([engine({ install: undefined })], isReady, never)).toEqual({ skip: "not-installable" });
  });
  it("installs through the standalone build or the package", () => {
    expect(freeEngineDecision([claude(false), engine()], isReady, never)).toEqual({ install: "opencodeGo" });
    expect(freeEngineDecision([engine({ install: { server: { package: {} } } })], isReady, never)).toEqual({ install: "opencodeGo" });
  });
});

describe("createFreeEngineInstaller", () => {
  let dir: string, statePath: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "free-engine-")); statePath = join(dir, "providers", "free-engine.json"); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function make(over: Partial<FreeEngineDeps> = {}) {
    const calls = { install: [] as string[], changed: 0, installed: [] as string[], log: [] as string[] };
    const installer = createFreeEngineInstaller<FreeEngineCandidate>({
      statePath, enabled: true,
      instances: async () => [claude(false), engine()], ready: isReady, refused: never,
      install: async (id) => { calls.install.push(id); return true; },
      changed: () => { calls.changed++; }, installed: async (id) => { calls.installed.push(id); }, log: (line) => { calls.log.push(line); },
      ...over,
    });
    return { installer, calls };
  }
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));

  it("installs once, writes a private state file, and does nothing on a second start", async () => {
    const { installer, calls } = make();
    await installer.start();
    await installer.start();
    expect(calls.install).toEqual(["opencodeGo"]);
    expect(calls.installed).toEqual(["opencodeGo"]);
    expect(calls.changed).toBe(3);
    expect(state()).toMatchObject({ outcome: "installed", attempts: 1 });
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
  });

  it("keeps a skip for good", async () => {
    const first = make({ instances: async () => [claude(true), engine()] });
    await first.installer.start();
    expect(state()).toMatchObject({ outcome: "skipped", reason: "ai-ready" });
    const second = make();
    await second.installer.start();
    expect(second.calls.install).toEqual([]);
  });

  it("retries a failure and stops after 3 attempts", async () => {
    const { installer, calls } = make({ install: async () => { throw new Error("offline"); } });
    for (let i = 0; i < 5; i++) await installer.start();
    expect(state()).toMatchObject({ outcome: "failed", attempts: 3 });
    expect(calls.log.filter((line) => line.includes("offline"))).toHaveLength(3);
    expect(calls.installed).toEqual([]);
  });

  it("counts an install that reports false as a failure", async () => {
    const { installer, calls } = make({ install: async () => false });
    await installer.start();
    expect(state()).toMatchObject({ outcome: "failed", attempts: 1 });
    expect(calls.installed).toEqual([]);
  });

  it("does nothing when disabled", async () => {
    const { installer, calls } = make({ enabled: false });
    await installer.start();
    expect(calls.install).toEqual([]);
    expect(existsSync(statePath)).toBe(false);
  });

  it("treats a corrupt state file as no state", async () => {
    const { installer, calls } = make();
    await installer.start();
    writeFileSync(statePath, "{not json");
    await installer.start();
    expect(calls.install).toEqual(["opencodeGo", "opencodeGo"]);
  });

  it("reports installing only during the install and joins a concurrent start", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen: boolean[] = [];
    const holder: { installer?: ReturnType<typeof make>["installer"] } = {};
    const made = make({ install: async (id) => { seen.push(holder.installer!.installing(id)); await gate; return true; } });
    holder.installer = made.installer;
    const { installer, calls } = made;
    expect(installer.installing("opencodeGo")).toBe(false);
    const a = installer.start(), b = installer.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(installer.installing("opencodeGo")).toBe(true);
    expect(installer.installing("other")).toBe(false);
    release();
    await Promise.all([a, b]);
    expect(installer.installing("opencodeGo")).toBe(false);
    expect(seen).toEqual([true]);
    expect(calls.changed).toBe(3);
  });

  it("never throws when listing the engines fails", async () => {
    const { installer, calls } = make({ instances: async () => { throw new Error("no registry"); } });
    await expect(installer.start()).resolves.toBeUndefined();
    expect(calls.log.some((line) => line.includes("no registry"))).toBe(true);
  });
});
