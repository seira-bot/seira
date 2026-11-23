import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ImportAgent, ImportEvent, ImportLeftover } from "../../shared/ai-import/bundle.ts";
import { HERMES_EXPORT, HERMES_EXPORT_LIMITS, HERMES_EXPORT_SKILL, refusedEntry } from "../../shared/ai-import/hermes-export.ts";
import { SKILL_FOLDER_LIMITS } from "../skill-folder.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { routineSchedule } from "./apply.ts";
import { memFiles, spyFiles } from "./fixtures/files-helpers.ts";
import { hermesReader } from "./hermes.ts";
import type { ImportFiles } from "./reader.ts";
import { READERS } from "./readers.ts";
import { sniffSource } from "./sniff.ts";
import { createApplyEnv, FAKE_KEY, runImport } from "./testing/apply-fixtures.ts";
import { ImportUploadError } from "./zip-reader.ts";

const SKILL_MD = "---\nname: daily-brief\ndescription: Write the morning brief.\n---\n\nRead the calendar first.\n";

type Manifest = Record<string, unknown>;

function manifest(agents: unknown[], source: Record<string, unknown> = {}): Manifest {
  return { format: HERMES_EXPORT.format, version: HERMES_EXPORT.version, source: { app: HERMES_EXPORT.app, ...source }, agents };
}

function exportFiles(body: Manifest | string, extra: Record<string, string | Buffer> = {}): ImportFiles {
  return memFiles({ [HERMES_EXPORT.manifest]: typeof body === "string" ? body : JSON.stringify(body), ...extra });
}

let staging: string;
beforeEach(() => {
  staging = mkdtempSync(join(tmpdir(), "seira-hermes-export-"));
});
afterEach(async () => {
  await removeTempDir(staging);
});

async function read(files: ImportFiles): Promise<ImportEvent[]> {
  const events: ImportEvent[] = [];
  const ctx = { signal: new AbortController().signal, stagingDir: staging, transcripts: true, instructions: "persona" as const };
  for await (const event of hermesReader.read({ from: "files", files }, ctx)) events.push(event);
  return events;
}

const agentsOf = (events: ImportEvent[]): ImportAgent[] => events.flatMap((event) => (event.type === "agent" ? [event.agent] : []));
const leftoversOf = (events: ImportEvent[]): ImportLeftover[] => events.flatMap((event) => (event.type === "leftover" ? [event.leftover] : []));
const fingerprintOf = (events: ImportEvent[]): string | undefined => events.find((event) => event.type === "source")?.source.fingerprint;

async function refusal(files: ImportFiles): Promise<string> {
  try {
    await read(files);
  } catch (error) {
    if (error instanceof ImportUploadError) return error.code;
    throw error;
  }
  return "read";
}

describe("Hermes export file", () => {
  it("picks the export by its manifest", async () => {
    const files = exportFiles(manifest([{ key: "hermes", name: "Hermes" }]));
    expect(await sniffSource(files, READERS)).toBe(hermesReader);

    const wrapped = memFiles({ [`seira-export-hermes-2026-11-23/${HERMES_EXPORT.manifest}`]: JSON.stringify(manifest([{ key: "hermes", name: "Hermes" }])) });
    expect(await hermesReader.sniff(wrapped)).toBe(true);

    expect(await hermesReader.sniff(memFiles({ "notes.json": JSON.stringify(manifest([])) }))).toBe(false);
    expect(await hermesReader.sniff(exportFiles({ format: "something-else" }))).toBe(false);
  });

  it("maps each agent", async () => {
    const files = exportFiles(manifest([
      {
        key: "hermes",
        name: "Hermes",
        persona: "You are Hermes. Keep answers short.",
        aboutYou: ["The user lives in Warsaw.", "  "],
        memories: ["Notes live in Obsidian.", "Coffee at 8."],
        skills: ["agents/hermes/skills/daily-brief"],
        routines: [{ name: "Morning brief", prompt: "Write my morning brief.", schedule: "30 7 * * *" }],
        channels: ["telegram", "discord"],
      },
      { key: "research-desk", name: "Research desk", memories: ["Cite sources."] },
    ], { timeZone: "Europe/Warsaw", instance: "3f9a0c1d2e4b5a6c" }), {
      "agents/hermes/skills/daily-brief/SKILL.md": SKILL_MD,
    });

    const events = await read(files);
    const [hermes, desk] = agentsOf(events);

    expect(events[0]).toMatchObject({ type: "source", source: { kind: "hermes" } });
    expect(hermes).toMatchObject({ ref: "hermes", name: "Hermes", persona: "You are Hermes. Keep answers short." });
    expect(hermes?.aboutYou).toEqual([{ ref: "memories/USER.md#0", text: "The user lives in Warsaw." }]);
    expect(hermes?.memories.map((item) => item.text)).toEqual(["Notes live in Obsidian.", "Coffee at 8."]);
    expect(hermes?.skills.map((skill) => skill.name)).toEqual(["daily-brief"]);
    expect(hermes?.routines).toEqual([{ ref: "cron/Morning brief", name: "Morning brief", schedule: "30 7 * * *", prompt: "Write my morning brief.", timeZone: "Europe/Warsaw" }]);
    expect(hermes?.channels.map((channel) => channel.kind)).toEqual(["telegram", "discord"]);
    expect(hermes?.tools).toEqual([]);
    expect(desk).toMatchObject({ ref: "research-desk", name: "Research desk" });
    expect(desk?.memories.map((item) => item.text)).toEqual(["Cite sources."]);
    expect(events.filter((event) => event.type === "conversation")).toEqual([]);
    expect(leftoversOf(events)).toEqual([]);
  });

  it("refuses a key file anywhere", async () => {
    const valid = manifest([{ key: "hermes", name: "Hermes", skills: ["agents/hermes/skills/daily-brief"] }]);
    for (const name of [
      ".env",
      "agents/hermes/skills/daily-brief/.env.local",
      "agents/hermes/auth.json",
      "agents/hermes/skills/daily-brief/id_ed25519",
      "agents/hermes/skills/daily-brief/server.PEM",
      "agents/hermes/skills/daily-brief/my_private_key.txt",
      "agents/hermes/skills/daily-brief/credentials/notes.txt",
      "agents/hermes/.ssh/config",
      "agents/hermes/mcp-tokens/github.json",
    ]) {
      const spy = spyFiles(exportFiles(valid, { "agents/hermes/skills/daily-brief/SKILL.md": SKILL_MD, [name]: "secret" }));
      expect(await refusal(spy.files), name).toBe("secret-file");
      expect(spy.opened, name).toEqual([]);
    }
    expect(readdirSync(staging)).toEqual([]);
  });

  it("refuses a nested archive", async () => {
    const valid = manifest([{ key: "hermes", name: "Hermes" }]);
    for (const name of ["agents/hermes/skills/daily-brief/data.zip", "backup.tar.gz", "notes.7z"]) {
      const spy = spyFiles(exportFiles(valid, { [name]: "PK" }));
      expect(await refusal(spy.files), name).toBe("unsafe-archive");
      expect(spy.opened, name).toEqual([]);
    }
  });

  it("refuses a broken manifest", async () => {
    const agent = { key: "hermes", name: "Hermes" };
    const cases: Array<[string, Manifest | string]> = [
      ["not JSON", "{ nope"],
      ["wrong format", { ...manifest([agent]), format: "other" }],
      ["wrong version", { ...manifest([agent]), version: 2 }],
      ["wrong app", { ...manifest([agent]), source: { app: "other" } }],
      ["no agents", manifest([])],
      ["agents not a list", { ...manifest([agent]), agents: { hermes: agent } }],
      ["too many agents", manifest(Array.from({ length: HERMES_EXPORT_LIMITS.agents + 1 }, (_, index) => ({ key: `a${index}`, name: `A${index}` })))],
      ["duplicate key", manifest([agent, agent])],
      ["bad key", manifest([{ key: "Bad Key", name: "Hermes" }])],
      ["no name", manifest([{ key: "hermes" }])],
      ["blank name", manifest([{ key: "hermes", name: "   " }])],
      ["long name", manifest([{ key: "hermes", name: "x".repeat(HERMES_EXPORT_LIMITS.nameChars + 1) }])],
      ["memory not text", manifest([{ ...agent, memories: [42] }])],
      ["routine without prompt", manifest([{ ...agent, routines: [{ name: "x", schedule: "every 1h" }] }])],
    ];
    for (const [label, body] of cases) expect(await refusal(exportFiles(body)), label).toBe("bad-export");

    const huge = exportFiles(manifest([agent]));
    const oversize: ImportFiles = { entries: [{ name: HERMES_EXPORT.manifest, size: HERMES_EXPORT_LIMITS.manifestBytes + 1 }], open: huge.open };
    expect(await refusal(oversize)).toBe("bad-export");
  });

  it("copies only named skills", async () => {
    const files = exportFiles(manifest([{ key: "hermes", name: "Hermes", skills: ["agents/hermes/skills/daily-brief/", "agents/other/skills/stray", "../outside"] }]), {
      "agents/hermes/skills/daily-brief/SKILL.md": SKILL_MD,
      "agents/hermes/skills/daily-brief/scripts/run.py": "print('hi')\n",
      "agents/hermes/skills/daily-brief/.git/config": "[core]\n",
      "agents/hermes/skills/daily-brief/node_modules/left-pad/index.js": "module.exports = 1;\n",
      "agents/hermes/skills/daily-brief/scripts/__pycache__/run.pyc": "x",
      "agents/hermes/skills/unlisted/SKILL.md": SKILL_MD,
      "agents/other/skills/stray/SKILL.md": SKILL_MD,
    });

    const events = await read(files);
    const [hermes] = agentsOf(events);
    const skill = hermes?.skills[0];

    expect(hermes?.skills.map((item) => item.name)).toEqual(["daily-brief"]);
    expect(skill?.dir.startsWith(staging)).toBe(true);
    expect(readFileSync(join(skill!.dir, "SKILL.md"), "utf8")).toBe(SKILL_MD);
    expect(existsSync(join(skill!.dir, "scripts", "run.py"))).toBe(true);
    for (const rebuilt of [".git", "node_modules", join("scripts", "__pycache__")]) expect(existsSync(join(skill!.dir, rebuilt)), rebuilt).toBe(false);
    expect(readdirSync(join(staging, "skills"))).toEqual(["0"]);
    expect(leftoversOf(events).map((item) => [item.kind, item.reason])).toEqual([["skill", "unreadable"], ["skill", "unreadable"]]);
  });

  it("reports a bad skill and keeps the rest", async () => {
    const crowded = Object.fromEntries(Array.from({ length: SKILL_FOLDER_LIMITS.files }, (_, index) => [`agents/hermes/skills/crowded/f${index}.txt`, "x"]));
    const files = exportFiles(manifest([{
      key: "hermes",
      name: "Hermes",
      memories: ["Kept."],
      skills: ["agents/hermes/skills/no-skill-md", "agents/hermes/skills/crowded", "agents/hermes/skills/daily-brief"],
    }]), {
      "agents/hermes/skills/no-skill-md/README.md": "No SKILL.md here.\n",
      "agents/hermes/skills/crowded/SKILL.md": SKILL_MD,
      ...crowded,
      "agents/hermes/skills/daily-brief/SKILL.md": SKILL_MD,
    });

    const events = await read(files);
    const [hermes] = agentsOf(events);

    expect(hermes?.skills.map((item) => item.name)).toEqual(["daily-brief"]);
    expect(hermes?.memories.map((item) => item.text)).toEqual(["Kept."]);
    expect(leftoversOf(events)).toEqual([
      { ref: "hermes/skills/no-skill-md", kind: "skill", name: "no-skill-md", reason: "unreadable" },
      { ref: "hermes/skills/crowded", kind: "skill", name: "crowded", reason: "too-large" },
    ]);
  });

  it("maps schedules and zones", async () => {
    const routines = [
      { name: "Weekdays", prompt: "Check the inbox.", schedule: "0 9 * * 1-5" },
      { name: "Often", prompt: "Look for news.", schedule: "every 30m" },
      { name: "Once", prompt: "Send the report.", schedule: "2027-01-05T09:00:00+01:00" },
      { name: "Relative", prompt: "Remind me.", schedule: "in 30m" },
      { name: "", prompt: "Water the plants on the balcony today please", schedule: "every 1d" },
    ];
    const events = await read(exportFiles(manifest([{ key: "hermes", name: "Hermes", routines }], { timeZone: "Asia/Jakarta" })));
    const [hermes] = agentsOf(events);

    expect(hermes?.routines.map((routine) => [routine.name, routine.schedule, routine.timeZone])).toEqual([
      ["Weekdays", "0 9 * * 1-5", "Asia/Jakarta"],
      ["Often", "every 30m", "Asia/Jakarta"],
      ["Once", "2027-01-05T08:00:00.000Z", "Asia/Jakarta"],
      ["Water the plants on the balcony", "every 1d", "Asia/Jakarta"],
    ]);
    expect(leftoversOf(events)).toEqual([{ ref: "hermes/cron/Relative", kind: "routine", name: "Relative", reason: "unsupported" }]);

    const unknownZone = agentsOf(await read(exportFiles(manifest([{ key: "hermes", name: "Hermes", routines: routines.slice(0, 1) }], { timeZone: "Mars/Base" }))));
    expect(unknownZone[0]?.routines[0]?.timeZone).toBeUndefined();

    expect(routineSchedule("0 9 * * 1-5", 0, "Asia/Jakarta")).toEqual({ type: "cron", expression: "0 9 * * 1-5", timeZone: "Asia/Jakarta" });
    expect(routineSchedule("0 9 * * 1-5", 0)).toEqual({ type: "cron", expression: "0 9 * * 1-5", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });
  });

  it("same instance, same fingerprint", async () => {
    const first = await read(exportFiles(manifest([{ key: "hermes", name: "Hermes", memories: ["One."] }], { instance: "3f9a0c1d2e4b5a6c" })));
    const second = await read(exportFiles(manifest([{ key: "hermes", name: "Hermes", memories: ["One.", "Two."] }], { instance: "3f9a0c1d2e4b5a6c" })));
    const other = await read(exportFiles(manifest([{ key: "hermes", name: "Hermes", memories: ["One."] }], { instance: "aaaaaaaaaaaaaaaa" })));
    const noInstance = await read(exportFiles(manifest([{ key: "hermes", name: "Hermes", memories: ["Two."] }])));

    expect(fingerprintOf(first)).toBe(fingerprintOf(second));
    expect(fingerprintOf(other)).not.toBe(fingerprintOf(first));
    expect(fingerprintOf(noInstance)).toBeTruthy();
    expect(fingerprintOf(noInstance)).not.toBe(fingerprintOf(first));
  });

  it("masks a key in a memory", async () => {
    const env = createApplyEnv();
    try {
      const events = await read(exportFiles(manifest([{
        key: "hermes",
        name: "Hermes",
        persona: `Use ${FAKE_KEY} for the weather service.`,
        memories: [`API_KEY=${FAKE_KEY}`],
        routines: [{ name: "Weather", prompt: `Call the API with ${FAKE_KEY}.`, schedule: "0 7 * * *" }],
      }], { timeZone: "Asia/Jakarta" })));
      const run = await runImport(env, { agents: agentsOf(events) });

      expect(env.ports.bots.soul(run.botId)).not.toContain(FAKE_KEY);
      expect(env.ports.memory.read(run.botId)).not.toContain(FAKE_KEY);
      const created = env.calls.filter((call) => call.name === "routines.create").map((call) => call.args[0] as { prompt: string; schedule: unknown });
      expect(created).toHaveLength(1);
      expect(created[0]?.prompt).not.toContain(FAKE_KEY);
      expect(created[0]?.schedule).toEqual({ type: "cron", expression: "0 7 * * *", timeZone: "Asia/Jakarta" });
    } finally {
      await env.dispose();
    }
  });

  it("skill text matches the reader", () => {
    for (const value of [HERMES_EXPORT.manifest, HERMES_EXPORT.format, HERMES_EXPORT.app, HERMES_EXPORT.skill, HERMES_EXPORT.filePrefix]) {
      expect(HERMES_EXPORT_SKILL).toContain(value);
    }
    expect(HERMES_EXPORT_SKILL).toContain(`"version": ${HERMES_EXPORT.version}`);
    expect(HERMES_EXPORT.version).toBe(1);
    expect(HERMES_EXPORT_LIMITS.skillFiles).toBe(SKILL_FOLDER_LIMITS.files);
    expect(HERMES_EXPORT_LIMITS.skillBytes).toBe(SKILL_FOLDER_LIMITS.bytes);

    for (const name of [".env", "auth.json", "id_ed25519", "credentials", ".ssh", "mcp-tokens", ".pem", ".zip", ".tar", ".gz", ".7z"]) {
      expect(HERMES_EXPORT_SKILL, name).toContain(`\`${name}`);
    }
    for (const name of [".env", "auth.json", "id_ed25519", "x.pem", "credentials/x", ".ssh/x", "mcp-tokens/x"]) expect(refusedEntry(name), name).toBe("secret");
    for (const name of ["x.zip", "x.tar", "x.gz", "x.7z"]) expect(refusedEntry(name), name).toBe("archive");
    for (const name of ["SKILL.md", "agents/hermes/skills/daily-brief/scripts/run.py", "environment.md", "keyboard.md"]) expect(refusedEntry(name), name).toBeNull();

    expect(HERMES_EXPORT_SKILL).toContain("<removed: ask the user>");
    expect(HERMES_EXPORT_SKILL).toContain("Do not open `.env`, `auth.json`, `state.db`, `sessions/`, `mcp-tokens/`");
    expect(HERMES_EXPORT_SKILL).toContain("a chat that only the user can read");
    expect(HERMES_EXPORT_SKILL).toContain("Never send it to a group");
  });
});
