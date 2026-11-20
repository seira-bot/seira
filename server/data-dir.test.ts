import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { recoverThreadGrantsOnce } from "./always-allow.ts";
import { browserEngineEncryptionKey } from "./browser-engine.ts";
import { DATA_DIR, ensureDirs, saveConfig } from "./config.ts";
import { ensurePrivateDir } from "./data-dir.ts";
import { Store } from "./store.ts";

const modeOf = (dir: string) => statSync(dir).mode & 0o7777;

let umask: number;
beforeEach(() => {
  umask = process.umask(0o022);
});
afterEach(() => {
  process.umask(umask);
});

describe.skipIf(process.platform === "win32")("ensurePrivateDir", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "private-dir-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("makes a missing folder, and each missing parent, 0700", () => {
    const dir = join(root, "parent", "data");
    ensurePrivateDir(dir);
    expect(modeOf(join(root, "parent"))).toBe(0o700);
    expect(modeOf(dir)).toBe(0o700);
  });

  it.each(["755", "775"])("tightens a folder left at the plain mkdir mode %s", (octal) => {
    const dir = join(root, "data");
    mkdirSync(dir);
    chmodSync(dir, Number.parseInt(octal, 8));
    ensurePrivateDir(dir);
    expect(modeOf(dir)).toBe(0o700);
  });

  it.each(["700", "711", "750", "2770"])("keeps the mode %s that its owner chose", (octal) => {
    const dir = join(root, "data");
    const mode = Number.parseInt(octal, 8);
    mkdirSync(dir);
    chmodSync(dir, mode);
    ensurePrivateDir(dir);
    expect(modeOf(dir)).toBe(mode);
  });
});

describe.skipIf(process.platform === "win32")("a fresh data folder", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it.each([
    ["the server start", () => ensureDirs()],
    ["a settings save", () => saveConfig({})],
    ["the bot registry", () => new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }))],
    ["the browser key", () => browserEngineEncryptionKey()],
    ["the grant recovery", () => recoverThreadGrantsOnce(DATA_DIR, [])],
  ])("is made private by %s", (_name, start) => {
    start();
    expect(modeOf(DATA_DIR)).toBe(0o700);
  });

  it("from an earlier start at 0755 is made private by the server start", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    chmodSync(DATA_DIR, 0o755);
    ensureDirs();
    expect(modeOf(DATA_DIR)).toBe(0o700);
  });
});

describe("data folder creation", () => {
  it("goes through ensurePrivateDir", () => {
    const server = fileURLToPath(new URL(".", import.meta.url));
    const direct = readdirSync(server, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "data-dir.ts")
      .flatMap((file) => readFileSync(join(server, file), "utf8").split("\n")
        .flatMap((line, index) => (/\bmkdirSync\(\s*(?:DATA_DIR|dataDir)\s*[,)]/u.test(line) ? [`${file}:${index + 1}`] : [])));
    expect(direct).toEqual([]);
  });
});
