import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";



const { opened, recording } = vi.hoisted(() => {
  const opened: string[] = [];
  const recording = <T extends (...args: never[]) => unknown>(fn: T): T => ((path: unknown, ...rest: unknown[]) => (opened.push(String(path)), (fn as unknown as (...args: unknown[]) => unknown)(path, ...rest))) as unknown as T;
  return { opened, recording };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createReadStream: recording(actual.createReadStream), readFileSync: recording(actual.readFileSync), openSync: recording(actual.openSync) };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: recording(actual.readFile), open: recording(actual.open), copyFile: recording(actual.copyFile), cp: recording(actual.cp) };
});
vi.mock("node:sqlite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:sqlite")>();
  return {
    ...actual,
    DatabaseSync: class extends actual.DatabaseSync {
      constructor(path: string, ...options: [ConstructorParameters<typeof actual.DatabaseSync>[1]?]) {
        opened.push(String(path));
        super(path, ...options);
      }
    },
  };
});

const { claudeCodeReader } = await import("./claude-code.ts");
const { hermesReader } = await import("./hermes.ts");
const { openclawReader } = await import("./openclaw.ts");
const { isSecretPath } = await import("./local-fs.ts");
const { collect, context, copyFixture, localSource, plantTraps, TRAP_TEXT, writeHermesDatabase, writeOpenclawDatabase } = await import("./local-fixtures.ts");

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "seira-ai-import-secrets-"));
  opened.length = 0;
});
afterEach(() => removeTempDir(scratch));

describe("local readers", () => {
  it("never opens credential files", async () => {
    const hermes = copyFixture("hermes", join(scratch, "hermes"));
    writeHermesDatabase(join(hermes, "state.db"));
    plantTraps(hermes, ["memories", "skills/pdf-notes", "profiles/work"]);
    const openclaw = copyFixture("openclaw", join(scratch, "openclaw"));
    writeOpenclawDatabase(join(openclaw, "agents", "main", "agent", "openclaw-agent.sqlite"));
    plantTraps(openclaw, ["workspace", "workspace/skills/summarize", "workspace-ops", "agents/main/agent", "sessions", "cron"]);
    const claude = copyFixture("claude-code", join(scratch, "claude"));
    plantTraps(claude, ["projects/-work-app", "projects/-work-app/memory", "rules"]);
    opened.length = 0;

    const events = [
      ...(await collect(hermesReader, localSource("hermes", hermes), context(join(scratch, "s1")))),
      ...(await collect(hermesReader, localSource("hermes", join(hermes, "profiles", "work"), "work"), context(join(scratch, "s2")))),
      ...(await collect(openclawReader, localSource("openclaw", join(openclaw, "workspace"), "main"), context(join(scratch, "s3")))),
      ...(await collect(openclawReader, localSource("openclaw", join(openclaw, "workspace-ops"), "ops"), context(join(scratch, "s4")))),
      ...(await collect(claudeCodeReader, localSource("claude-code", claude), context(join(scratch, "s5"), true))),
    ];

    expect(opened.length).toBeGreaterThan(10);
    expect(opened.filter(isSecretPath)).toEqual([]);
    expect(opened.some((path) => /[\\/]credentials[\\/]/.test(path))).toBe(false);
    expect(JSON.stringify(events)).not.toContain(TRAP_TEXT);
  });

  it("refuses to open a credential path, whoever asks", () => {
    for (const path of ["/h/.env", "/h/.env.local", "/h/auth.json", "/h/.credentials.json", "/h/secrets.json", "/h/a/auth-profiles.json", "/h/credentials/x", "C:\\h\\credentials\\x"]) expect(isSecretPath(path)).toBe(true);
    for (const path of ["/h/SOUL.md", "/h/skills/env/SKILL.md", "/h/memory/credentials.md"]) expect(isSecretPath(path)).toBe(false);
  });

  it("does not copy credential files out of a skill folder", async () => {
    const hermes = copyFixture("hermes", join(scratch, "hermes"));
    plantTraps(hermes, ["skills/pdf-notes"]);
    const staging = join(scratch, "stage");
    mkdirSync(staging);
    const events = await collect(hermesReader, localSource("hermes", hermes), context(staging));
    const skill = events.flatMap((event) => (event.type === "agent" ? event.agent.skills : [])).find((item) => item.name === "pdf-notes");
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(skill!.dir).sort()).toEqual(["SKILL.md"]);
  });
});
