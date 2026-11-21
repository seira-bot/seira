import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AI_IMPORT_LIMITS } from "../../shared/ai-import/limits.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { locateLocalSources } from "./locate.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "seira-ai-import-locate-"));
});
afterEach(() => removeTempDir(home));

const touch = (...parts: string[]) => {
  const path = join(home, ...parts);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
};

describe("locateLocalSources", () => {
  it("finds nothing in an empty home", async () => {
    expect(await locateLocalSources({}, home)).toEqual([]);
  });

  it("finds profiles", async () => {
    touch(".hermes", "SOUL.md");
    touch(".hermes", "profiles", "work", "config.yaml");
    touch(".hermes", "profiles", "empty", "notes.txt");
    const started = Date.now();
    const found = await locateLocalSources({}, home);
    expect(Date.now() - started).toBeLessThan(AI_IMPORT_LIMITS.locateMs);
    expect(found.map((source) => [source.kind, source.profile, source.name])).toEqual([
      ["hermes", undefined, "Hermes"],
      ["hermes", "work", "Hermes · work"],
    ]);
    expect(new Set(found.map((source) => source.id)).size).toBe(2);
    expect(await locateLocalSources({}, home)).toEqual(found);
  });

  it("prefers HERMES_HOME over the default home", async () => {
    touch(".hermes", "SOUL.md");
    touch("elsewhere", "SOUL.md");
    const found = await locateLocalSources({ HERMES_HOME: join(home, "elsewhere") }, home);
    expect(found.map((source) => source.path)).toEqual([join(home, "elsewhere")]);
  });

  it("ignores a relative HERMES_HOME", async () => {
    touch(".hermes", "SOUL.md");
    const found = await locateLocalSources({ HERMES_HOME: "relative" }, home);
    expect(found.map((source) => source.path)).toEqual([join(home, ".hermes")]);
  });

  it("old names: finds OpenClaw under the old state folders, one source for each agent workspace", async () => {
    touch(".clawdbot", "clawdbot.json");
    touch(".clawdbot", "workspace", "SOUL.md");
    touch(".clawdbot", "workspace-ops", "SOUL.md");
    touch(".moltbot", "moltbot.json");
    const found = await locateLocalSources({}, home);
    expect(found.map((source) => [source.kind, source.profile, source.path])).toEqual([
      ["openclaw", "main", join(home, ".clawdbot", "workspace")],
      ["openclaw", "ops", join(home, ".clawdbot", "workspace-ops")],
    ]);
  });

  it("looks in OPENCLAW_STATE_DIR first and adds OPENCLAW_WORKSPACE_DIR", async () => {
    touch(".openclaw", "openclaw.json");
    touch("state", "openclaw.json");
    touch("state", "workspace-a", "SOUL.md");
    touch("loose", "SOUL.md");
    const found = await locateLocalSources({ OPENCLAW_STATE_DIR: join(home, "state"), OPENCLAW_WORKSPACE_DIR: join(home, "loose") }, home);
    expect(found.map((source) => [source.profile, source.path])).toEqual([
      ["a", join(home, "state", "workspace-a")],
      ["main", join(home, "loose")],
    ]);
  });

  it("finds Claude Code in CLAUDE_CONFIG_DIR or the default home", async () => {
    touch(".claude", "CLAUDE.md");
    expect((await locateLocalSources({}, home)).map((source) => source.path)).toEqual([join(home, ".claude")]);
    touch("cfg", "CLAUDE.md");
    const found = await locateLocalSources({ CLAUDE_CONFIG_DIR: join(home, "cfg") }, home);
    expect(found.map((source) => [source.kind, source.path])).toEqual([["claude-code", join(home, "cfg")]]);
  });

  it("gives ids that do not reveal the path", async () => {
    touch(".claude", "CLAUDE.md");
    const [source] = await locateLocalSources({}, home);
    expect(source?.id).toMatch(/^[0-9a-f]{16}$/);
  });
});
