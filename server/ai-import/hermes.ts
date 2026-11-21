import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { emptyAgent, type ImportAgent, type ImportEvent, type ImportLeftover } from "../../shared/ai-import/bundle.ts";
import { collectSkills, everySchedule, routineFrom, textSchedule, toolFromConfig } from "./local-agent.ts";
import { databaseConversations, openDatabaseCopy } from "./local-chats.ts";
import { isFile, isRecord, readText, sourceId, splitEntries } from "./local-fs.ts";
import type { ImportInput, ReaderContext, SourceReader } from "./reader.ts";

function hermesSchedule(value: unknown): string | null {
  if (typeof value === "string") return textSchedule(value);
  if (!isRecord(value)) return null;
  const expr = [value.expr, value.cron, value.display].find((item): item is string => typeof item === "string");
  if (value.kind === "interval" || value.kind === "every") {
    if (typeof value.minutes === "number") return everySchedule(value.minutes * 60_000);
    if (typeof value.ms === "number") return everySchedule(value.ms);
  }
  if (typeof value.run_at === "string") return textSchedule(value.run_at);
  return expr ? textSchedule(expr) : null;
}

async function* readHermes(input: ImportInput, ctx: ReaderContext): AsyncGenerator<ImportEvent> {
  if (input.from !== "local") throw new Error("The Hermes reader needs a local folder");
  const { source } = input;
  const home = source.path;
  const ref = source.profile ?? "default";
  yield { type: "source", source: { kind: "hermes", ...(source.profile ? { profile: source.profile } : {}), fingerprint: sourceId("hermes", home, source.profile) } };

  const agent: ImportAgent = emptyAgent(ref, source.name);
  const leftovers: ImportLeftover[] = [];

  const soul = await readText(join(home, "SOUL.md"));
  if (soul?.trim()) agent.persona = soul.trim();
  agent.aboutYou = splitEntries((await readText(join(home, "memories", "USER.md"))) ?? "").map((text, index) => ({ ref: `memories/USER.md#${index}`, text }));
  agent.memories = splitEntries((await readText(join(home, "memories", "MEMORY.md"))) ?? "").map((text, index) => ({ ref: `memories/MEMORY.md#${index}`, text }));

  const skills = await collectSkills(join(home, "skills"), ctx.stagingDir);
  agent.skills = skills.skills;
  leftovers.push(...skills.leftovers);

  const configText = await readText(join(home, "config.yaml"));
  if (configText !== null) {
    let config: unknown;
    try {
      config = parseYaml(configText);
    } catch {
      leftovers.push({ ref: "config.yaml#mcp_servers", kind: "tool", reason: "unreadable" }, { ref: "config.yaml#platforms", kind: "channel", reason: "unreadable" });
    }
    if (isRecord(config)) {
      if (isRecord(config.mcp_servers)) {
        for (const [name, entry] of Object.entries(config.mcp_servers)) {
          const tool = toolFromConfig(name, entry);
          if (tool) agent.tools.push(tool);
          else leftovers.push({ ref: `mcp/${name}`, kind: "tool", name, reason: "unsupported" });
        }
      }
      if (isRecord(config.platforms)) agent.channels = Object.keys(config.platforms).map((kind) => ({ ref: `platforms/${kind}`, kind }));
    }
  }

  const cronText = await readText(join(home, "cron", "jobs.json"));
  if (cronText !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(cronText);
    } catch {
      leftovers.push({ ref: "cron/jobs.json", kind: "routine", reason: "unreadable" });
    }
    const jobs = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.jobs) ? parsed.jobs : [];
    jobs.forEach((job: unknown, index) => {
      if (!isRecord(job)) return;
      const id = typeof job.id === "string" || typeof job.id === "number" ? String(job.id) : String(index);
      const name = typeof job.name === "string" && job.name ? job.name : id;
      const prompt = typeof job.prompt === "string" ? job.prompt : "";
      const made = routineFrom(`cron/${id}`, name, hermesSchedule(job.schedule), prompt);
      if (made.routine) agent.routines.push(made.routine);
      if (made.leftover) leftovers.push(made.leftover);
    });
  }

  yield { type: "agent", agent };
  for (const leftover of leftovers) yield { type: "leftover", leftover };

  if (await isFile(join(home, "state.db"))) {
    const db = await openDatabaseCopy(join(home, "state.db"), ctx.stagingDir, "hermes-state");
    if (!db) {
      yield { type: "leftover", leftover: { ref: "state.db", kind: "conversation", name: "state.db", reason: "locked" } };
      return;
    }
    try {
      let done = 0;
      for (const conversation of databaseConversations(db)) {
        if (ctx.signal.aborted) return;
        yield { type: "conversation", agentRef: ref, conversation };
        yield { type: "progress", done: ++done, total: null, unit: "items" };
      }
    } catch {
      yield { type: "leftover", leftover: { ref: "state.db", kind: "conversation", name: "state.db", reason: "unreadable" } };
    } finally {
      db.close();
    }
  }
}

export const hermesReader: SourceReader = {
  kind: "hermes",
  sniff: async () => false,
  read: readHermes,
};
