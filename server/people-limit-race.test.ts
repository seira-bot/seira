// Real processes against one data folder: the server admits a person while `seira access add` adds another, and only
// one place is free. A check and a write that another process can split lets both in, or loses one of the writes.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { PEOPLE_FILE } from "./people-limit.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const CHILD = fileURLToPath(new URL("./testing/people-race-child.ts", import.meta.url));
const ROUNDS = 25;
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

function run(base: string, role: "admit" | "access", id: number, firstStart: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", CHILD, base, role, String(id), String(firstStart), String(ROUNDS), "60"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out.trim()) as string[]) : reject(new Error(`child ${role}${id} exited ${code}: ${err}`))));
  });
}

describe.skipIf(process.platform === "win32")("places held by more than one process", () => {
  it("lets exactly one of four processes take the last free place, in every round", async () => {
    const base = mkdtempSync(join(tmpdir(), "seira-people-race-"));
    dirs.push(base);
    const four = ["p1@corp.test", "p2@corp.test", "p3@corp.test", "p4@corp.test"];
    for (let round = 0; round < ROUNDS; round += 1) {
      mkdirSync(join(base, `round-${round}`));
      writeFileSync(join(base, `round-${round}`, PEOPLE_FILE), `${JSON.stringify({ version: 1, people: four })}\n`);
    }
    const firstStart = Date.now() + 6_000;
    // Two stand for the server (an @domain address signs in), two for `seira access add` (an address is added).
    const answers = await Promise.all([run(base, "admit", 1, firstStart), run(base, "admit", 2, firstStart), run(base, "access", 3, firstStart), run(base, "access", 4, firstStart)]);
    for (let round = 0; round < ROUNDS; round += 1) {
      const admitted = answers.filter((one) => one[round] === "in").length;
      const people: string[] = JSON.parse(readFileSync(join(base, `round-${round}`, PEOPLE_FILE), "utf8")).people;
      // One place was free: the free plan holds five people, and each answer "in" is a place that the file keeps.
      expect({ round, admitted, people: people.length }).toEqual({ round, admitted: 1, people: 5 });
    }
  }, 60_000);
});
