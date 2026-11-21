import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ImportDestination, ImportJobView, ImportReport } from "../../../shared/ai-import/api.ts";
import { emptyCounts } from "../../../shared/ai-import/api.ts";
import { emptyAgent, type ImportAgent, type ImportConversation, type ImportSource } from "../../../shared/ai-import/bundle.ts";
import { DATA_DIR } from "../../config.ts";
import { closeMessageDb } from "../../message-db.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { applyChats, applyFastLane, buildReport, type ApplyContext, type FastLaneResult } from "../apply.ts";
import { ImportDb } from "../db.ts";
import { CHATS_FILE, type SpoolLine } from "../spool.ts";
import { importHarness, type ImportHarness } from "./harness.ts";

export const NOW = Date.UTC(2026, 10, 1, 12);
export const DAY = 24 * 60 * 60 * 1000;
export const FAKE_KEY = "sk-FAKEFAKEFAKEFAKEFAKEFAKE0000";
export const SOURCE: ImportSource = { kind: "chatgpt", fingerprint: "export-one" };
export const LABEL = "ChatGPT";

export interface PortCall {
  name: string;
  args: unknown[];
}

export interface ApplyEnv extends ImportHarness {
  db: ImportDb;
  staging: string;
  calls: PortCall[];
  context(overrides?: Partial<ApplyContext>): ApplyContext;
  stageSkill(name: string, body: string): string;
  writeSpool(lines: SpoolLine[]): void;
  dispose(): Promise<void>;
}

function spyOn(env: ImportHarness, calls: PortCall[]): void {
  for (const [group, methods] of Object.entries(env.ports)) {
    const table = methods as Record<string, (...args: unknown[]) => unknown>;
    for (const [method, original] of Object.entries(table)) {
      table[method] = (...args: unknown[]) => {
        calls.push({ name: `${group}.${method}`, args });
        return original(...args);
      };
    }
  }
}

/** A fresh data folder, a real Store and a private import database and staging folder. */
export function createApplyEnv(): ApplyEnv {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  const harness = importHarness();
  const scratch = mkdtempSync(join(tmpdir(), "ai-import-apply-"));
  const staging = join(scratch, "staging");
  mkdirSync(staging, { recursive: true });
  const db = new ImportDb(join(scratch, "db"));
  const calls: PortCall[] = [];
  spyOn(harness, calls);
  return {
    ...harness,
    db,
    staging,
    calls,
    context: (overrides = {}) => ({
      jobId: "job-1", db, ports: harness.ports, source: SOURCE, label: LABEL, agents: [], destinations: {}, stagingDir: staging, now: () => NOW,
      ...overrides,
    }),
    stageSkill: (name, body) => {
      const dir = join(staging, "skills", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: A skill called ${name}.\n---\n${body}\n`);
      return dir;
    },
    writeSpool: (lines) => {
      const file = join(staging, CHATS_FILE);
      if (!lines.length) rmSync(file, { force: true });
      else writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    },
    dispose: async () => {
      db.close();
      closeMessageDb();
      await removeTempDir(scratch);
    },
  };
}

/** A conversation of `count` messages in one chain; a longer one with the same ref continues a shorter one. */
export function conversation(ref: string, title: string, count: number, text = (index: number) => `${ref} message ${index}`): ImportConversation {
  const messages = Array.from({ length: count }, (_, index) => ({
    ref: `${ref}-m${index + 1}`,
    parentRef: index === 0 ? null : `${ref}-m${index}`,
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text: text(index + 1),
    at: NOW - (count - index) * 1000,
  }));
  return { ref, title, createdAt: NOW - count * 1000, updatedAt: NOW, activeLeafRef: messages.at(-1)?.ref ?? null, messages };
}

export const spool = (agentRef: string, conversations: ImportConversation[]): SpoolLine[] =>
  conversations.map((entry) => ({ agentRef, conversation: entry }));

export interface AgentOptions {
  ref?: string;
  /** Changes every text of the agent, so a second import sees new content. */
  version?: number;
}

/** An agent with every kind of item the fast lane writes. */
export function fullAgent(env: ApplyEnv, options: AgentOptions = {}): ImportAgent {
  const version = options.version ?? 1;
  const tag = `v${version}`;
  return {
    ...emptyAgent(options.ref ?? "a1", "Scout Import"),
    persona: `You are a careful research partner (${tag}).`,
    howToReply: [{ ref: "reply-1", text: "Answer in short sentences." }],
    aboutYou: [{ ref: "about-1", text: `Works in logistics (${tag}).` }],
    memories: [
      { ref: "mem-1", text: `Prefers metric units (${tag}).` },
      { ref: "mem-2", text: `Lives in Surabaya (${tag}).` },
    ],
    topics: [{ ref: "topic-1", title: "Garden notes", text: `Tomatoes need sun (${tag}).` }],
    skills: [{ ref: "skill-1", name: "tidy-notes", dir: env.stageSkill("tidy-notes", `Keep notes tidy (${tag}).`) }],
    tools: [
      { ref: "tool-files", name: "Files Server", transport: "stdio", command: "npx", args: ["-y", "fake-files-server", tag], needsKey: ["FILES_API_KEY"] },
      { ref: "tool-web", name: "Web Search", transport: "http", url: `https://mcp.example.test/search?v=${version}`, needsKey: ["WEB_AUTH_KEY"] },
    ],
    routines: [
      { ref: "routine-1", name: "Morning brief", schedule: "0 8 * * *", prompt: `Summarize the news (${tag}).` },
      { ref: "routine-2", name: "Check inbox", schedule: "every 2h", prompt: `Look for new mail (${tag}).` },
    ],
    channels: [{ ref: "chan-1", kind: "telegram", name: "Team chat" }, { ref: "chan-2", kind: "slack" }],
  };
}

export interface RunOptions {
  jobId?: string;
  agents: ImportAgent[];
  chats?: SpoolLine[];
  destinations?: Record<string, ImportDestination>;
}

export interface RunResult {
  ctx: ApplyContext;
  fast: FastLaneResult;
  status: "done" | "cancelled" | "paused";
  progress: number[];
  report: ImportReport;
  botId: string;
}

/** The apply steps of one job: the fast lane, then the chats, then the report. */
export async function runImport(env: ApplyEnv, options: RunOptions): Promise<RunResult> {
  const ctx = env.context({ jobId: options.jobId ?? "job-1", agents: options.agents, destinations: options.destinations ?? {} });
  env.writeSpool(options.chats ?? []);
  const fast = applyFastLane(ctx);
  const progress: number[] = [];
  const status = await applyChats(ctx, fast.bots, { fast: true, conv: 0, msg: 0, done: 0 }, {
    stop: () => null,
    progress: (done) => { progress.push(done); },
  });
  const report = buildReport(ctx, fast.bots, fast.leftovers);
  return { ctx, fast, status, progress, report, botId: fast.bots[options.agents[0]!.ref]! };
}

export function jobView(id: string, undoUntil: number | null): ImportJobView {
  return {
    id,
    source: { kind: SOURCE.kind },
    state: "done",
    createdAt: NOW,
    updatedAt: NOW,
    progress: { done: 0, total: 0, unit: "items" },
    counts: emptyCounts(),
    agents: [],
    report: null,
    undoUntil,
    undoResult: null,
    error: null,
  };
}
