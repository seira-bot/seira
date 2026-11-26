// Real processes against one data folder: Settings saves config.json while `seira access` adds and removes addresses in it.
// A save that reads config.json, changes it and writes it with no lock can write over an address that another process
// saved in between.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";

const CHILD = fileURLToPath(new URL("./testing/config-write-child.ts", import.meta.url));
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

function run(home: string, role: "settings" | "access", rounds: number, id: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", CHILD, role, String(rounds), String(id)], {
      env: { PATH: process.env.PATH ?? "", HOME: home, SEIRA_DATA_DIR: join(home, "data") },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`child ${role} exited ${code}: ${err}`))));
  });
}

describe.skipIf(process.platform === "win32")("config.json written by more than one process", () => {
  it("keeps every address that `seira access` saved while Settings saves other settings", async () => {
    const home = mkdtempSync(join(tmpdir(), "seira-config-race-"));
    dirs.push(home);
    const rounds = 30;
    await Promise.all([run(home, "settings", 60, 1), run(home, "settings", 60, 2), run(home, "access", rounds, 3)]);
    const saved = JSON.parse(readFileSync(join(home, "data", "config.json"), "utf8")) as { language?: string; signIn?: { admins?: string[] } };
    const odd = Array.from({ length: rounds }, (_, round) => `c${round}@corp.test`).filter((_, round) => round % 2 === 1);
    expect([...(saved.signIn?.admins ?? [])].sort()).toEqual(odd.sort());
    expect(saved.language).toMatch(/^l[12]-59$/);
  }, 60_000);
});
