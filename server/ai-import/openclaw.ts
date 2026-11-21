import { basename, join } from "node:path";

import { emptyAgent, type ImportAgent, type ImportConversation, type ImportEvent, type ImportLeftover } from "../../shared/ai-import/bundle.ts";
import { userHome } from "../env-path.ts";
import { collectSkills, everySchedule, markdownEntries, routineFrom, textSchedule, toolFromConfig } from "./local-agent.ts";
import { databaseConversations, decodeMessageBody, jsonlConversation, openDatabaseCopy, type JsonlEntry } from "./local-chats.ts";
import { isFile, isRecord, listNames, readText, sourceId, toMillis } from "./local-fs.ts";
import { openclawConfigPath, openclawStateDirOf } from "./locate.ts";
import { parseJson5Lite } from "./json5-lite.ts";
import type { ImportInput, ReaderContext, SourceReader } from "./reader.ts";

const DAILY_NOTE = /^(\d{4}-\d{2}-\d{2})\.md$/;

function cronSchedule(value: unknown): string | null {
  if (typeof value === "string") return textSchedule(value);
  if (!isRecord(value)) return null;
  if (value.kind === "cron" && typeof value.expr === "string") return textSchedule(value.expr);
  if (value.kind === "every" && typeof value.everyMs === "number") return everySchedule(value.everyMs);
  if (value.kind === "at" && typeof value.at === "string") return textSchedule(value.at);
  return null;
}

function decodeSessionLine(line: Record<string, unknown>): JsonlEntry | null {
  if (typeof line.id !== "string") return null;
  const parentId = typeof line.parentId === "string" ? line.parentId : null;
  const body = isRecord(line.message) ? line.message : null;
  const role = body?.role;
  if (line.type !== "message" || !body || (role !== "user" && role !== "assistant")) return { id: line.id, parentId, message: null };
  const { text, notes } = decodeMessageBody(body.content);
  if (!text && notes.length === 0) return { id: line.id, parentId, message: null };
  return { id: line.id, parentId, message: { role, text, at: toMillis(line.timestamp) ?? toMillis(body.timestamp), notes } };
}

async function* readOpenclaw(input: ImportInput, ctx: ReaderContext): AsyncGenerator<ImportEvent> {
  if (input.from !== "local") throw new Error("The OpenClaw reader needs a local folder");
  const { source } = input;
  const workspace = source.path;
  const agentId = source.profile ?? "main";
  yield { type: "source", source: { kind: "openclaw", ...(source.profile ? { profile: source.profile } : {}), fingerprint: sourceId("openclaw", workspace, source.profile) } };

  const stateDir = await openclawStateDirOf(workspace, process.env, userHome());
  const agent: ImportAgent = emptyAgent(agentId, source.name);
  const leftovers: ImportLeftover[] = [];

  const persona = [await readText(join(workspace, "SOUL.md")), await readText(join(workspace, "IDENTITY.md"))].map((part) => part?.trim()).filter(Boolean).join("\n\n");
  if (persona) agent.persona = persona;
  agent.aboutYou = markdownEntries((await readText(join(workspace, "USER.md"))) ?? "").map((text, index) => ({ ref: `USER.md#${index}`, text }));
  agent.memories = markdownEntries((await readText(join(workspace, "MEMORY.md"))) ?? "").map((text, index) => ({ ref: `MEMORY.md#${index}`, text }));

  for (const name of await listNames(join(workspace, "memory"))) {
    const date = DAILY_NOTE.exec(name)?.[1];
    if (!date) continue;
    const text = await readText(join(workspace, "memory", name));
    if (text?.trim()) agent.dailyNotes.push({ ref: `memory/${name}`, date, text: text.trim() });
  }
  const agents = await readText(join(workspace, "AGENTS.md"));
  if (agents?.trim()) agent.topics.push({ ref: "AGENTS.md", title: "AGENTS.md", text: agents.trim() });

  const skills = await collectSkills(join(workspace, "skills"), ctx.stagingDir);
  agent.skills = skills.skills;
  leftovers.push(...skills.leftovers);

  let config: Record<string, unknown> | null = null;
  const configPath = stateDir ? await openclawConfigPath(stateDir) : null;
  if (configPath) {
    const text = await readText(configPath);
    try {
      const parsed = text === null ? null : parseJson5Lite(text);
      if (isRecord(parsed)) config = parsed;
      else throw new Error("not an object");
    } catch {
      leftovers.push({ ref: "config#mcp", kind: "tool", reason: "unreadable" }, { ref: "config#channels", kind: "channel", reason: "unreadable" });
    }
  }
  if (config) {
    const servers = isRecord(config.mcp) && isRecord(config.mcp.servers) ? config.mcp.servers : {};
    for (const [name, entry] of Object.entries(servers)) {
      const tool = toolFromConfig(name, entry);
      if (tool) agent.tools.push(tool);
      else leftovers.push({ ref: `mcp/${name}`, kind: "tool", name, reason: "unsupported" });
    }
    if (isRecord(config.channels)) agent.channels = Object.keys(config.channels).map((kind) => ({ ref: `channels/${kind}`, kind }));
  }

  const cron = stateDir ? await readText(join(stateDir, "cron", "jobs.json")) : null;
  if (cron !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(cron);
    } catch {
      leftovers.push({ ref: "cron/jobs.json", kind: "routine", reason: "unreadable" });
    }
    const jobs = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.jobs) ? parsed.jobs : [];
    jobs.forEach((job: unknown, index) => {
      if (!isRecord(job)) return;
      if ((typeof job.agentId === "string" ? job.agentId : "main") !== agentId) return;
      const id = typeof job.id === "string" || typeof job.id === "number" ? String(job.id) : String(index);
      const payload = isRecord(job.payload) ? job.payload : {};
      const prompt = [payload.message, payload.text, job.prompt].find((item): item is string => typeof item === "string") ?? "";
      const made = routineFrom(`cron/${id}`, typeof job.name === "string" && job.name ? job.name : id, cronSchedule(job.schedule), prompt);
      if (made.routine) agent.routines.push(made.routine);
      if (made.leftover) leftovers.push(made.leftover);
    });
  }

  const heartbeat = (await readText(join(workspace, "HEARTBEAT.md"))) ?? "";
  if (markdownEntries(heartbeat).length > 0) {
    const defaults = isRecord(config?.agents) && isRecord(config.agents.defaults) ? config.agents.defaults : {};
    const every = isRecord(defaults.heartbeat) && typeof defaults.heartbeat.every === "string" ? textSchedule(`every ${defaults.heartbeat.every}`) : null;
    agent.routines.push({ ref: "HEARTBEAT.md", name: "Heartbeat", schedule: every ?? "every 30m", prompt: heartbeat.replace(/<!--[\s\S]*?-->/g, "").trim() });
  }

  yield { type: "agent", agent };
  for (const leftover of leftovers) yield { type: "leftover", leftover };
  if (!stateDir) return;

  const seen = new Set<string>();
  let done = 0;
  const emit = (conversation: ImportConversation): ImportEvent[] => {
    if (seen.has(conversation.ref)) return [];
    seen.add(conversation.ref);
    return [{ type: "conversation", agentRef: agentId, conversation }, { type: "progress", done: ++done, total: null, unit: "items" }];
  };

  const sqlite = join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
  if (await isFile(sqlite)) {
    const db = await openDatabaseCopy(sqlite, ctx.stagingDir, "openclaw-agent");
    if (!db) yield { type: "leftover", leftover: { ref: "openclaw-agent.sqlite", kind: "conversation", name: "openclaw-agent.sqlite", reason: "locked" } };
    else {
      try {
        for (const conversation of databaseConversations(db)) {
          if (ctx.signal.aborted) return;
          yield* emit(conversation);
        }
      } catch {
        yield { type: "leftover", leftover: { ref: "openclaw-agent.sqlite", kind: "conversation", name: "openclaw-agent.sqlite", reason: "unreadable" } };
      } finally {
        db.close();
      }
    }
  }

  const folders = [join(stateDir, "agents", agentId, "sessions"), ...(agentId === "main" ? [join(stateDir, "sessions")] : [])];
  for (const folder of folders) {
    for (const name of await listNames(folder)) {
      if (!name.endsWith(".jsonl") || ctx.signal.aborted) continue;
      const ref = basename(name, ".jsonl");
      if (seen.has(ref)) continue;
      try {
        const conversation = await jsonlConversation(join(folder, name), ref, ctx.signal, decodeSessionLine);
        if (conversation) yield* emit(conversation);
      } catch {
        yield { type: "leftover", leftover: { ref: `sessions/${name}`, kind: "conversation", name, reason: "unreadable" } };
      }
    }
  }
}

export const openclawReader: SourceReader = {
  kind: "openclaw",
  sniff: async () => false,
  read: readOpenclaw,
};
