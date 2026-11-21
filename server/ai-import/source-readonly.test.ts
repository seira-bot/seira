import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { claudeCodeReader } from "./claude-code.ts";
import { hermesReader } from "./hermes.ts";
import { collect, context, copyFixture, localSource, plantTraps, writeHermesDatabase, writeOpenclawDatabase } from "./local-fixtures.ts";
import { openclawReader } from "./openclaw.ts";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "seira-ai-import-readonly-"));
});
afterEach(() => removeTempDir(scratch));

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      const key = relative(root, path);
      out[`${key}${item.isDirectory() ? "/" : ""}`] = `${statSync(path).mtimeMs}`;
      if (item.isDirectory()) walk(path);
      else out[`${key}#hash`] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(root);
  return out;
}

describe("local readers leave the source folder as it was", () => {
  it("keeps every file's hash and modification time, and adds no file", async () => {
    const hermes = copyFixture("hermes", join(scratch, "hermes"));
    writeHermesDatabase(join(hermes, "state.db"));
    plantTraps(hermes, ["profiles/work"]);
    const openclaw = copyFixture("openclaw", join(scratch, "openclaw"));
    writeOpenclawDatabase(join(openclaw, "agents", "main", "agent", "openclaw-agent.sqlite"));
    plantTraps(openclaw, ["workspace"]);
    const claude = copyFixture("claude-code", join(scratch, "claude"));
    plantTraps(claude, []);

    const runs = [
      { root: hermes, run: () => collect(hermesReader, localSource("hermes", hermes), context(join(scratch, "s1"))) },
      { root: hermes, run: () => collect(hermesReader, localSource("hermes", join(hermes, "profiles", "work"), "work"), context(join(scratch, "s2"))) },
      { root: openclaw, run: () => collect(openclawReader, localSource("openclaw", join(openclaw, "workspace"), "main"), context(join(scratch, "s3"))) },
      { root: openclaw, run: () => collect(openclawReader, localSource("openclaw", join(openclaw, "workspace-ops"), "ops"), context(join(scratch, "s4"))) },
      { root: claude, run: () => collect(claudeCodeReader, localSource("claude-code", claude), context(join(scratch, "s5"), true)) },
    ];
    for (const { root, run } of runs) {
      const before = snapshot(root);
      const events = await run();
      expect(events.length).toBeGreaterThan(1);
      expect(snapshot(root)).toEqual(before);
    }
  });
});
