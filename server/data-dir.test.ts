import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it.each(["755", "775", "750", "711", "777", "2755", "2770", "1777"])("removes every group and other bit from a folder at %s", (octal) => {
    const dir = join(root, "data");
    mkdirSync(dir);
    chmodSync(dir, Number.parseInt(octal, 8));
    ensurePrivateDir(dir);
    expect(modeOf(dir)).toBe(0o700);
  });

  it("keeps a folder that is already 0700", () => {
    const dir = join(root, "data");
    mkdirSync(dir, { mode: 0o700 });
    ensurePrivateDir(dir);
    expect(modeOf(dir)).toBe(0o700);
  });

  it("makes a missing folder 0700 under umask 027", () => {
    process.umask(0o027);
    const dir = join(root, "parent", "data");
    ensurePrivateDir(dir);
    expect(modeOf(join(root, "parent"))).toBe(0o700);
    expect(modeOf(dir)).toBe(0o700);
  });

  it("clears the setgid bit a new folder inherits from its parent", () => {
    chmodSync(root, 0o2770);
    const dir = join(root, "parent", "data");
    ensurePrivateDir(dir);
    expect(modeOf(join(root, "parent"))).toBe(0o700);
    expect(modeOf(dir)).toBe(0o700);
  });

  it.each([
    ["755", 0o755, 0o750],
    ["777", 0o777, 0o770],
    ["2755", 0o2755, 0o2750],
    ["2770", 0o2770, 0o2770],
  ])("with group access on, takes only the other bits from a folder at %s", (_octal, before, after) => {
    const dir = join(root, "data");
    mkdirSync(dir);
    chmodSync(dir, before);
    ensurePrivateDir(dir, { groupAccess: true });
    expect(modeOf(dir)).toBe(after);
  });

  it("reads group access from SEIRA_DATA_DIR_GROUP_ACCESS", () => {
    vi.stubEnv("SEIRA_DATA_DIR_GROUP_ACCESS", "1");
    const dir = join(root, "data");
    mkdirSync(dir);
    chmodSync(dir, 0o775);
    ensurePrivateDir(dir);
    expect(modeOf(dir)).toBe(0o770);
    vi.unstubAllEnvs();
    ensurePrivateDir(dir);
    expect(modeOf(dir)).toBe(0o700);
  });

  it("stops when chmod fails and the folder stays open", () => {
    const dir = join(root, "data");
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    const refused = () => {
      throw Object.assign(new Error("read-only file system"), { code: "EROFS" });
    };
    expect(() => ensurePrivateDir(dir, { chmod: refused })).toThrow(/open to other accounts \(mode 755\)/u);
    expect(modeOf(dir)).toBe(0o755);
  });

  it("stops when chmod does nothing", () => {
    const dir = join(root, "data");
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    expect(() => ensurePrivateDir(dir, { chmod: () => {} })).toThrow(/could not be made private/u);
  });

  it.skipIf(process.getuid?.() === 0)("stops on an open folder that another account owns, and leaves it alone", () => {
    expect(() => ensurePrivateDir("/usr")).toThrow(/could not be made private/u);
    expect(modeOf("/usr") & 0o022).toBe(0);
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
