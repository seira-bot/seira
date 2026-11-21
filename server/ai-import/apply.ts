import { createReadStream, existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

import type { ImportDestination, ImportNextSteps, ImportReport } from "../../shared/ai-import/api.ts";
import type {
  ImportAgent, ImportConversation, ImportLeftover, ImportMessage, ImportRoutine, ImportSkill, ImportSource, ImportTool,
} from "../../shared/ai-import/bundle.ts";
import { AI_IMPORT_LIMITS } from "../../shared/ai-import/limits.ts";
import { redactSecretsInText } from "../../shared/redact.ts";
import { isSkillName, readSkillFrontmatter, SKILL_NAME_MAX } from "../../shared/skill-md.ts";
import type { RoutineScheduleInput } from "../routines.ts";
import { SKILL_FOLDER_LIMITS, skillFileText, type SkillFolderFile } from "../skill-folder.ts";
import type { ImportedMessageInput, ImportedThreadInput } from "../store-imported.ts";
import { UNTITLED_TASK } from "../thread-title.ts";
import { MEMORY_ENTRY_MAX_CHARS, MEMORY_MAX_BYTES, MEMORY_MAX_LINES, memoryEntry } from "../workspace.ts";
import type { ApplyCursor, Fingerprint, FingerprintKey, ImportDb, Receipt, ReceiptKind } from "./db.ts";
import { hashOf, sha256, stableId } from "./ids.ts";
import type { ImportPorts } from "./ports.ts";
import { conversationHash, currentHash, decide, restoreSkill } from "./receipts.ts";
import { CHATS_FILE, type SpoolLine } from "./spool.ts";

export const CHAT_BATCH = AI_IMPORT_LIMITS.chatBatchMessages;
export const PERSONA_MAX_BYTES = AI_IMPORT_LIMITS.personaBytes;

export interface ApplyContext {
  jobId: string;
  db: ImportDb;
  ports: ImportPorts;
  source: ImportSource;
  /** The product name that marks what this job brings in. */
  label: string;
  agents: ImportAgent[];
  destinations: Record<string, ImportDestination>;
  /** The job's staging folder: the spool and the staged skill copies. Null when the job has no files. */
  stagingDir: string | null;
  now: () => number;
  batchSize?: number;
}

export interface FastLaneResult {
  /** Agent ref → the bot that holds what came from it. */
  bots: Record<string, string>;
  leftovers: ImportLeftover[];
}

export interface ChatHooks {
  /** Asked after each batch: "cancel" ends the job there, "pause" leaves it to continue after a restart. */
  stop(): "cancel" | "pause" | null;
  progress(done: number): void;
}

type Target = Record<string, unknown>;

interface Written {
  target: Target;
  before?: unknown;
  action?: "added" | "updated";
  keptBoth?: boolean;
}

interface ItemSpec {
  itemKey: string;
  kind: ReceiptKind;
  name: string;
  botId: string;
  contentHash: string;
  add(keepBoth: boolean): Written | null;
  update(target: Target): Written | null;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const redact = (value: string | undefined): string => redactSecretsInText(value ?? "").trim();
const short = (value: string): string => {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
};

function fingerprintKey(ctx: ApplyContext, itemKey: string): FingerprintKey {
  return { sourceKind: ctx.source.kind, sourceFp: ctx.source.fingerprint, itemKey };
}

/** The former import of this item into the same bot, if any. */
function previousFor(ctx: ApplyContext, key: FingerprintKey, botId: string): { stored: Fingerprint | null; previous: Fingerprint | null } {
  const stored = ctx.db.fingerprint(key);
  return { stored, previous: stored && text(stored.target.botId) === botId ? stored : null };
}

function record(ctx: ApplyContext, spec: Pick<ItemSpec, "itemKey" | "kind" | "name" | "contentHash">, written: Written, stored: Fingerprint | null, hash: string): Receipt {
  const key = fingerprintKey(ctx, spec.itemKey);
  return ctx.db.transaction(() => {
    const receipt = ctx.db.addReceipt(ctx.jobId, {
      itemKey: spec.itemKey,
      kind: spec.kind,
      action: written.action ?? "added",
      keptBoth: written.keptBoth,
      target: written.target,
      before: written.before ?? null,
      written: hash,
      name: spec.name,
      fingerprint: key,
      previous: stored,
    });
    ctx.db.putFingerprint({ ...key, contentHash: spec.contentHash, target: written.target, written: hash, jobId: ctx.jobId, at: ctx.now() });
    return receipt;
  });
}

/** Adds, updates, keeps both or skips one item by the re-import rule, and records what it wrote. */
function applyItem(ctx: ApplyContext, spec: ItemSpec): Receipt | null {
  const done = ctx.db.receipt(ctx.jobId, spec.itemKey);
  if (done) return done;
  const { stored, previous } = previousFor(ctx, fingerprintKey(ctx, spec.itemKey), spec.botId);
  const current = previous ? currentHash(spec.kind, previous.target, ctx.ports) : null;
  const decision = decide(previous, spec.contentHash, current);
  if (decision === "skip") return null;
  let written: Written | null;
  if (decision === "update") {
    const out = spec.update(previous!.target);
    written = out && { action: "updated", ...out, target: out.target ?? previous!.target };
  } else {
    written = spec.add(decision === "keep-both");
    if (written && decision === "keep-both") written.keptBoth = true;
  }
  if (!written) return null;
  return record(ctx, spec, written, stored, currentHash(spec.kind, written.target, ctx.ports) ?? "");
}

function freeName(taken: (name: string) => boolean, base: string, join: (base: string, n: number) => string): string {
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = join(base, n);
    if (!taken(candidate)) return candidate;
  }
}

function topicFileName(title: string, fallback: string): string {
  const cleaned = title.normalize("NFC")
    .replace(/\.md$/i, "")
    .replace(/[^\p{L}\p{N}_ .-]+/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[^\p{L}\p{N}_]+/u, "")
    .trim();
  const base = [...cleaned].slice(0, 120).join("").replace(/[ .]+$/, "");
  return `${base || fallback}.md`;
}

function freeTopic(ctx: ApplyContext, botId: string, name: string): string {
  const stem = name.slice(0, -3);
  return freeName((candidate) => ctx.ports.memory.readTopic(botId, candidate) !== null, name, (_, n) => `${stem} ${n}.md`);
}

function topicBody(label: string, body: string): string {
  return `_From ${label}_\n\n${body.trim()}\n`;
}

function applyTopic(ctx: ApplyContext, botId: string, itemKey: string, fileName: string, body: string, contentHash: string, keptBoth = false): Receipt | null {
  return applyItem(ctx, {
    itemKey,
    kind: "topic",
    name: fileName.slice(0, -3),
    botId,
    contentHash,
    add: () => {
      const topic = freeTopic(ctx, botId, fileName);
      ctx.ports.memory.writeTopic(botId, topic, body);
      return { target: { botId, topic }, keptBoth };
    },
    update: (target) => {
      const topic = text(target.topic);
      const before = ctx.ports.memory.readTopic(botId, topic);
      ctx.ports.memory.writeTopic(botId, topic, body);
      return { target, before };
    },
  });
}

function ensureBot(ctx: ApplyContext, agent: ImportAgent, created: Set<string>): string {
  const itemKey = `${agent.ref}/bot`;
  const key = fingerprintKey(ctx, itemKey);
  const destination = ctx.destinations[agent.ref] ?? { kind: "new" };
  if (destination.kind === "bot" && ctx.ports.bots.exists(destination.botId)) {
    ctx.db.putFingerprint({ ...key, contentHash: "bot", target: { botId: destination.botId }, written: "bot", jobId: ctx.jobId, at: ctx.now() });
    return destination.botId;
  }
  const done = ctx.db.receipt(ctx.jobId, itemKey);
  if (done && ctx.ports.bots.exists(text(done.target.botId))) {
    created.add(text(done.target.botId));
    return text(done.target.botId);
  }
  const names = new Set(ctx.ports.bots.names().map((name) => name.toLowerCase()));
  const wanted = agent.name.replace(/\s+/g, " ").trim().slice(0, 60) || ctx.label;
  const name = freeName((candidate) => names.has(candidate.toLowerCase()), wanted, (base, n) => `${base} ${n}`);
  const botId = ctx.ports.bots.create(name);
  created.add(botId);
  record(ctx, { itemKey, kind: "bot", name, contentHash: "bot" }, { target: { botId } }, ctx.db.fingerprint(key), "bot");
  return botId;
}

function cutBytes(value: string, max: number): [string, string] {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= max) return [value, ""];
  let end = max;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return [bytes.subarray(0, end).toString("utf8"), bytes.subarray(end).toString("utf8")];
}

function personaText(agent: ImportAgent): string {
  const persona = redact(agent.persona);
  const reply = agent.howToReply.map((item) => redact(item.text).replace(/\s*\n\s*/g, " ")).filter(Boolean).map((line) => `- ${line}`);
  return [persona, reply.length ? `## How to reply\n${reply.join("\n")}` : ""].filter(Boolean).join("\n\n");
}

function applyPersona(ctx: ApplyContext, agent: ImportAgent, botId: string, created: Set<string>): void {
  const imported = personaText(agent);
  if (!imported) return;
  const itemKey = `${agent.ref}/persona`;
  const contentHash = sha256(imported);
  const asTopic = () => applyTopic(ctx, botId, `${agent.ref}/persona-topic`, topicFileName(`Persona from ${ctx.label}`, "Persona"),
    topicBody(ctx.label, imported), contentHash, true);
  let rest = "";
  const receipt = applyItem(ctx, {
    itemKey,
    kind: "persona",
    name: agent.name,
    botId,
    contentHash,
    add: (keepBoth) => {
      const soul = ctx.ports.bots.soul(botId);
      const own = !created.has(botId) && soul.trim() !== "";
      if (keepBoth || (own && agent.persona?.trim())) {
        asTopic();
        return null;
      }
      const prefix = own ? `${soul.trimEnd()}\n\n` : "";
      const [head, tail] = cutBytes(`${prefix}${imported}`, PERSONA_MAX_BYTES);
      rest = tail;
      ctx.ports.bots.setSoul(botId, head);
      return { target: { botId, base: prefix.length }, before: soul, action: own ? "updated" : "added" };
    },
    update: (target) => {
      const before = ctx.ports.bots.soul(botId);
      const base = typeof target.base === "number" ? Math.min(target.base, before.length) : 0;
      const [head, tail] = cutBytes(`${before.slice(0, base)}${imported}`, PERSONA_MAX_BYTES);
      rest = tail;
      ctx.ports.bots.setSoul(botId, head);
      return { target, before };
    },
  });
  if (receipt && rest) {
    applyTopic(ctx, botId, `${agent.ref}/persona-rest`, topicFileName(`Persona from ${ctx.label} - continued`, "Persona"),
      topicBody(ctx.label, rest), sha256(rest));
  }
}

function applyAboutYou(ctx: ApplyContext, agent: ImportAgent, botId: string): void {
  const texts = agent.aboutYou.map((item) => redact(item.text)).filter(Boolean);
  if (!texts.length) return;
  const now = new Date(ctx.now());
  const lines = texts.map((line) => memoryEntry(line, { source: ctx.label, now }));
  applyTopic(ctx, botId, `${agent.ref}/about-you`, topicFileName(`About you from ${ctx.label}`, "About you"),
    `# About you\n\n${lines.join("\n")}\n`, hashOf(texts));
}

/** Memory entries go to MEMORY.md while it stays within the prompt budget; the rest go to one topic. */
function applyMemories(ctx: ApplyContext, agent: ImportAgent, botId: string): void {
  const now = new Date(ctx.now());
  const file = ctx.ports.memory.read(botId);
  const lines = file ? file.split("\n") : [];
  while (lines.length && lines.at(-1) === "") lines.pop();
  let bytes = Buffer.byteLength(lines.join("\n"), "utf8");
  const planned: Array<{ itemKey: string; contentHash: string; line: string; name: string; before: string | null; stored: Fingerprint | null }> = [];
  const overflow: string[] = [];
  const overflowTexts: string[] = [];
  for (const item of agent.memories) {
    const itemKey = `${agent.ref}/memory/${item.ref}`;
    if (ctx.db.receipt(ctx.jobId, itemKey)) continue;
    const entryText = redact(item.text);
    if (!entryText) continue;
    const contentHash = sha256(entryText);
    const { stored, previous } = previousFor(ctx, fingerprintKey(ctx, itemKey), botId);
    const oldLine = previous ? text(previous.target.line) : "";
    const at = oldLine ? lines.indexOf(oldLine) : -1;
    const decision = decide(previous, contentHash, at >= 0 ? sha256(oldLine) : null);
    if (decision === "skip") continue;
    const line = memoryEntry(entryText, { source: ctx.label, now });
    if (entryText.length > MEMORY_ENTRY_MAX_CHARS) {
      overflow.push(line);
      overflowTexts.push(entryText);
      continue;
    }
    if (decision === "update") {
      bytes += Buffer.byteLength(line, "utf8") - Buffer.byteLength(oldLine, "utf8");
      lines[at] = line;
      planned.push({ itemKey, contentHash, line, name: short(entryText), before: oldLine, stored });
      continue;
    }
    const added = Buffer.byteLength(line, "utf8") + (lines.length ? 1 : 0);
    if (lines.length + 1 > MEMORY_MAX_LINES || bytes + added > MEMORY_MAX_BYTES) {
      overflow.push(line);
      overflowTexts.push(entryText);
      continue;
    }
    lines.push(line);
    bytes += added;
    planned.push({ itemKey, contentHash, line, name: short(entryText), before: null, stored });
  }
  if (planned.length) {
    ctx.ports.memory.write(botId, `${lines.join("\n")}\n`);
    ctx.db.transaction(() => {
      for (const item of planned) {
        const target = { botId, line: item.line };
        const written = sha256(item.line);
        const key = fingerprintKey(ctx, item.itemKey);
        ctx.db.addReceipt(ctx.jobId, {
          itemKey: item.itemKey, kind: "memory", action: item.before === null ? "added" : "updated", target, before: item.before,
          written, name: item.name, fingerprint: key, previous: item.stored,
        });
        ctx.db.putFingerprint({ ...key, contentHash: item.contentHash, target, written, jobId: ctx.jobId, at: ctx.now() });
      }
    });
  }
  if (overflow.length) {
    applyTopic(ctx, botId, `${agent.ref}/memory-overflow`, topicFileName(`Memories from ${ctx.label}`, "Memories"),
      `${overflow.join("\n")}\n`, hashOf(overflowTexts));
  }
}

function applyTopics(ctx: ApplyContext, agent: ImportAgent, botId: string): void {
  for (const topic of agent.topics) {
    const body = redact(topic.text);
    if (!body) continue;
    applyTopic(ctx, botId, `${agent.ref}/topic/${topic.ref}`, topicFileName(redact(topic.title), `Topic from ${ctx.label}`),
      topicBody(ctx.label, body), sha256(body));
  }
}

function applyDailyNotes(ctx: ApplyContext, agent: ImportAgent, botId: string, leftovers: ImportLeftover[]): void {
  for (const note of agent.dailyNotes) {
    const body = redact(note.text);
    if (!body) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(note.date)) {
      leftovers.push({ ref: note.ref, kind: "memory", name: note.date, reason: "unsupported" });
      continue;
    }
    const log = `${note.date}.md`;
    const section = `## From ${ctx.label}\n\n${body}\n`;
    applyItem(ctx, {
      itemKey: `${agent.ref}/daily/${note.ref}`,
      kind: "daily",
      name: note.date,
      botId,
      contentHash: sha256(body),
      add: () => {
        const existing = ctx.ports.memory.readLog(botId, log);
        if (existing === null || !existing.trim()) {
          ctx.ports.memory.writeLog(botId, log, section);
          return { target: { botId, log, base: 0 }, before: existing };
        }
        const head = `${existing.trimEnd()}\n\n`;
        ctx.ports.memory.writeLog(botId, log, `${head}${section}`);
        return { target: { botId, log, base: head.length }, before: existing, action: "updated" };
      },
      update: (target) => {
        const before = ctx.ports.memory.readLog(botId, log) ?? "";
        const base = typeof target.base === "number" ? Math.min(target.base, before.length) : 0;
        ctx.ports.memory.writeLog(botId, log, `${before.slice(0, base)}${section}`);
        return { target, before };
      },
    });
  }
}

/** Reads a staged skill copy. Only paths inside the job's staging folder; links and special files stay out. */
function stagedSkillFiles(stagingDir: string, dir: string): SkillFolderFile[] | null {
  const root = resolve(dir);
  const base = resolve(stagingDir);
  if (!root.startsWith(base + sep)) return null;
  const files: SkillFolderFile[] = [];
  let total = 0;
  const walk = (folder: string, prefix: string): void => {
    for (const entry of readdirSync(folder).sort()) {
      if (files.length >= SKILL_FOLDER_LIMITS.files) return;
      const full = join(folder, entry);
      const path = prefix ? `${prefix}/${entry}` : entry;
      const stat = lstatSync(full);
      if (stat.isDirectory()) {
        if (path.split("/").length < SKILL_FOLDER_LIMITS.depth) walk(full, path);
        continue;
      }
      if (!stat.isFile() || stat.size > SKILL_FOLDER_LIMITS.fileBytes || total + stat.size > SKILL_FOLDER_LIMITS.bytes) continue;
      total += stat.size;
      const bytes = readFileSync(full);
      const asText = skillFileText(bytes);
      files.push({ path, content: asText === null ? new Uint8Array(bytes) : redactSecretsInText(asText), executable: (stat.mode & 0o111) !== 0 });
    }
  };
  try {
    if (!lstatSync(root).isDirectory()) return null;
    walk(root, "");
  } catch {
    return null;
  }
  return files;
}

function renameSkill(files: SkillFolderFile[], name: string): SkillFolderFile[] {
  return files.map((file) => file.path === "SKILL.md" && typeof file.content === "string"
    ? { ...file, content: file.content.replace(/^(﻿?---\r?\n(?:[^\r\n]*\r?\n)*?)name:[^\r\n]*/, `$1name: ${name}`) }
    : file);
}

function applySkills(ctx: ApplyContext, agent: ImportAgent, botId: string, leftovers: ImportLeftover[]): void {
  const leave = (skill: ImportSkill) => leftovers.push({ ref: skill.ref, kind: "skill", name: skill.name, reason: "unsupported" });
  for (const skill of agent.skills) {
    const itemKey = `${agent.ref}/skill/${skill.ref}`;
    if (ctx.db.receipt(ctx.jobId, itemKey)) continue;
    const files = ctx.stagingDir ? stagedSkillFiles(ctx.stagingDir, skill.dir) : null;
    const skillMd = files?.find((file) => file.path === "SKILL.md")?.content;
    const named = typeof skillMd === "string" ? readSkillFrontmatter(skillMd)?.fields.name ?? "" : "";
    if (!files || !isSkillName(named)) {
      leave(skill);
      continue;
    }
    const install = (name: string, on: boolean): { target: Target } | null => {
      const installed = ctx.ports.skills.install(botId, `import:${ctx.source.kind}`, name === named ? files : renameSkill(files, name));
      if ("error" in installed) return null;
      if (on && !installed.flagged) ctx.ports.skills.enable(botId, installed.name);
      return { target: { botId, name: installed.name, flagged: installed.flagged } };
    };
    let failed = false;
    applyItem(ctx, {
      itemKey,
      kind: "skill",
      name: named,
      botId,
      contentHash: hashOf(files.map((file) => [file.path, sha256(file.content)])),
      add: (keepBoth) => {
        const taken = (name: string) => ctx.ports.skills.hash(botId, name) !== null;
        const name = keepBoth || taken(named)
          ? freeName(taken, named, (base, n) => `${base.slice(0, SKILL_NAME_MAX - String(n).length - 1)}-${n}`)
          : named;
        const out = install(name, true);
        failed = !out;
        return out;
      },
      update: (target) => {
        const name = text(target.name);
        const files = ctx.ports.skills.files(botId, name);
        const enabled = ctx.ports.skills.enabled(botId, name);
        ctx.ports.skills.remove(botId, name);
        const out = install(name, enabled);
        if (!out) {
          if (files) restoreSkill(ctx.ports, botId, { files, enabled });
          failed = true;
          return null;
        }
        return { ...out, before: files && { files, enabled } };
      },
    });
    if (failed) leave(skill);
  }
}

function toolServer(tool: ImportTool): Record<string, unknown> | null {
  const keys = Object.fromEntries(tool.needsKey.map((key) => [key, ""]));
  if (tool.transport === "stdio") {
    const command = redact(tool.command);
    return command ? { command, args: (tool.args ?? []).map((arg) => redactSecretsInText(arg)), env: keys, enabled: false } : null;
  }
  const url = redact(tool.url);
  return url ? { type: "http", url, headers: keys, enabled: false } : null;
}

function toolName(raw: string): string {
  const name = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 32).replace(/-+$/, "");
  return name || "tool";
}

/** Tools arrive switched off, with the names of the keys they need and no values. */
function applyTools(ctx: ApplyContext, agent: ImportAgent, botId: string, leftovers: ImportLeftover[]): void {
  if (!agent.tools.length) return;
  const servers = ctx.ports.tools.servers();
  const botTools = new Set(ctx.ports.bots.tools(botId));
  const planned: Array<{ itemKey: string; name: string; contentHash: string; before: unknown; action: "added" | "updated"; keptBoth: boolean; stored: Fingerprint | null; keys: string[] }> = [];
  const leave = (tool: ImportTool, reason: ImportLeftover["reason"]) => leftovers.push({ ref: tool.ref, kind: "tool", name: tool.name, reason });
  for (const tool of agent.tools) {
    const itemKey = `${agent.ref}/tool/${tool.ref}`;
    if (ctx.db.receipt(ctx.jobId, itemKey)) continue;
    const server = toolServer(tool);
    if (!server) {
      leave(tool, "unsupported");
      continue;
    }
    const contentHash = hashOf({ transport: tool.transport, command: tool.command ?? null, args: tool.args ?? [], url: tool.url ?? null, keys: tool.needsKey });
    const { stored, previous } = previousFor(ctx, fingerprintKey(ctx, itemKey), botId);
    const oldName = previous ? text(previous.target.name) : "";
    const current = previous && servers[oldName] !== undefined ? hashOf(servers[oldName]) : null;
    const decision = decide(previous, contentHash, current);
    if (decision === "skip") continue;
    const name = decision === "update"
      ? oldName
      : freeName((candidate) => servers[candidate] !== undefined || ctx.ports.tools.nameError(candidate) !== null, toolName(tool.name),
        (base, n) => `${base.slice(0, 31 - String(n).length)}-${n}`);
    const check = ctx.ports.tools.check(name, server);
    if (check) {
      leave(tool, check === "refused" ? "locked" : "unsupported");
      continue;
    }
    const before = decision === "update" ? servers[name] : null;
    servers[name] = server;
    botTools.add(name);
    planned.push({ itemKey, name, contentHash, before, action: decision === "update" ? "updated" : "added", keptBoth: decision === "keep-both", stored, keys: tool.needsKey });
  }
  if (!planned.length) return;
  ctx.ports.tools.persist(servers);
  ctx.ports.bots.setTools(botId, [...botTools]);
  const saved = ctx.ports.tools.servers();
  ctx.db.transaction(() => {
    for (const item of planned) {
      const target = { botId, name: item.name, keys: item.keys };
      const written = saved[item.name] === undefined ? "" : hashOf(saved[item.name]);
      const key = fingerprintKey(ctx, item.itemKey);
      ctx.db.addReceipt(ctx.jobId, {
        itemKey: item.itemKey, kind: "tool", action: item.action, keptBoth: item.keptBoth, target, before: item.before, written,
        name: item.name, fingerprint: key, previous: item.stored,
      });
      ctx.db.putFingerprint({ ...key, contentHash: item.contentHash, target, written, jobId: ctx.jobId, at: ctx.now() });
    }
  });
}

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function routineSchedule(schedule: string, now: number): RoutineScheduleInput | null {
  const value = schedule.trim();
  const every = /^every\s*(\d{1,6})\s*([mhd])$/i.exec(value);
  if (every) {
    const minutes = Number(every[1]) * ({ m: 1, h: 60, d: 1440 } as const)[every[2]!.toLowerCase() as "m" | "h" | "d"];
    return minutes > 0 ? { type: "interval", everyMinutes: minutes, anchorAt: now } : null;
  }
  if (/^\S+(?:\s+\S+){4}$/.test(value)) return { type: "cron", expression: value, timeZone: localTimeZone() };
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
    const at = Date.parse(value);
    return Number.isFinite(at) ? { type: "once", at } : null;
  }
  return null;
}

/** Routines arrive paused. */
function applyRoutines(ctx: ApplyContext, agent: ImportAgent, botId: string, leftovers: ImportLeftover[]): void {
  const leave = (routine: ImportRoutine) => leftovers.push({ ref: routine.ref, kind: "routine", name: routine.name, reason: "unsupported" });
  for (const routine of agent.routines) {
    const itemKey = `${agent.ref}/routine/${routine.ref}`;
    if (ctx.db.receipt(ctx.jobId, itemKey)) continue;
    const schedule = routineSchedule(routine.schedule, ctx.now());
    const prompt = redact(routine.prompt);
    const name = routine.name.replace(/\s+/g, " ").trim().slice(0, 120) || `Routine from ${ctx.label}`;
    if (!schedule || !prompt) {
      leave(routine);
      continue;
    }
    let failed = false;
    applyItem(ctx, {
      itemKey,
      kind: "routine",
      name,
      botId,
      contentHash: hashOf({ name, prompt, schedule: routine.schedule }),
      add: () => {
        try {
          return { target: { botId, routineId: ctx.ports.routines.create({ botId, name, prompt, schedule }) } };
        } catch {
          failed = true;
          return null;
        }
      },
      update: (target) => {
        const id = text(target.routineId);
        const old = ctx.ports.routines.get(id);
        try {
          ctx.ports.routines.update(id, { name, prompt, schedule });
        } catch {
          failed = true;
          return null;
        }
        return { target, before: old && { name: old.name, prompt: old.prompt, schedule: old.schedule } };
      },
    });
    if (failed) leave(routine);
  }
}

/** Persona, About you, memory, topics, daily notes, skills, tools and routines: everything before the chats. */
export function applyFastLane(ctx: ApplyContext): FastLaneResult {
  const bots: Record<string, string> = {};
  const leftovers: ImportLeftover[] = [];
  const created = new Set<string>();
  for (const agent of ctx.agents) {
    const botId = ensureBot(ctx, agent, created);
    bots[agent.ref] = botId;
    applyPersona(ctx, agent, botId, created);
    applyAboutYou(ctx, agent, botId);
    applyMemories(ctx, agent, botId);
    applyTopics(ctx, agent, botId);
    applyDailyNotes(ctx, agent, botId, leftovers);
    applySkills(ctx, agent, botId, leftovers);
    applyTools(ctx, agent, botId, leftovers);
    applyRoutines(ctx, agent, botId, leftovers);
  }
  return { bots, leftovers };
}

/** Parents before children; a message whose parent is missing or in a loop starts a new branch. */
function treeOrder(conversation: ImportConversation): ImportMessage[] {
  const known = new Set(conversation.messages.map((message) => message.ref));
  const children = new Map<string | null, ImportMessage[]>();
  for (const message of conversation.messages) {
    const parent = message.parentRef !== null && message.parentRef !== message.ref && known.has(message.parentRef) ? message.parentRef : null;
    const list = children.get(parent);
    if (list) list.push(message);
    else children.set(parent, [message]);
  }
  const out: ImportMessage[] = [];
  const seen = new Set<string>();
  const visit = (roots: ImportMessage[]) => {
    const stack = [...roots].reverse();
    while (stack.length) {
      const message = stack.pop()!;
      if (seen.has(message.ref)) continue;
      seen.add(message.ref);
      out.push(message);
      const next = children.get(message.ref);
      if (next) for (let i = next.length - 1; i >= 0; i--) stack.push(next[i]!);
    }
  };
  visit(children.get(null) ?? []);
  for (const message of conversation.messages) {
    if (!seen.has(message.ref)) visit([{ ...message, parentRef: null }]);
  }
  return out;
}

function messageText(message: ImportMessage): string {
  const lines = [redact(message.text)];
  for (const attachment of message.attachments ?? []) lines.push(`📎 ${redact(attachment.name)}`);
  for (const note of message.notes ?? []) {
    if (note.kind === "tool-call") lines.push(`🔧 ${redact(note.name)}`);
    else if (note.name) lines.push(`📎 ${redact(note.name)}`);
  }
  return lines.filter(Boolean).join("\n\n");
}

function chatMessages(conversation: ImportConversation, threadId: string, fallbackAt: number): { messages: ImportedMessageInput[]; leaf: string | null } {
  const ids = new Map<string, string | null>();
  const messages: ImportedMessageInput[] = [];
  let lastAt = Number.isFinite(conversation.createdAt) ? conversation.createdAt! : fallbackAt;
  for (const message of treeOrder(conversation)) {
    const parentId = message.parentRef === null ? null : ids.get(message.parentRef) ?? null;
    const body = messageText(message);
    if (!body) {
      ids.set(message.ref, parentId);
      continue;
    }
    const id = stableId(threadId, message.ref);
    ids.set(message.ref, id);
    const at = typeof message.at === "number" && Number.isFinite(message.at) ? message.at : lastAt;
    lastAt = at;
    messages.push({ id, parentId, role: message.role === "assistant" ? "bot" : "user", text: body, at });
  }
  const chosen = conversation.activeLeafRef === null ? undefined : ids.get(conversation.activeLeafRef);
  return { messages, leaf: chosen === undefined ? messages.at(-1)?.id ?? null : chosen };
}

interface OpenChat {
  itemKey: string;
  name: string;
  botId: string;
  threadId: string;
  update: boolean;
  keptBoth: boolean;
  thread: ImportedThreadInput;
  messages: ImportedMessageInput[];
  leaf: string | null;
  contentHash: string;
  stored: Fingerprint | null;
  before: { activeLeafId: string | null } | null;
  addedIds: string[];
  receipt: Receipt | null;
}

/** Writes the spooled chats as archived conversations, in batches of `batchSize` messages with one transaction each. */
export async function applyChats(ctx: ApplyContext, bots: Record<string, string>, cursor: ApplyCursor, hooks: ChatHooks): Promise<"done" | "cancelled" | "paused"> {
  const file = ctx.stagingDir ? join(ctx.stagingDir, CHATS_FILE) : null;
  if (!file || !existsSync(file)) return "done";
  const size = ctx.batchSize ?? CHAT_BATCH;
  let done = cursor.done ?? 0;
  let parts: Array<{ chat: OpenChat; from: number; to: number }> = [];
  let count = 0;

  const flush = async (next: { conv: number; msg: number }): Promise<"cancel" | "pause" | null> => {
    const chats = [...new Set(parts.map((part) => part.chat))];
    ctx.db.transaction(() => {
      for (const chat of chats) {
        chat.receipt ??= ctx.db.addReceipt(ctx.jobId, {
          itemKey: chat.itemKey, kind: "conversation", action: chat.update ? "updated" : "added",
          keptBoth: chat.keptBoth,
          target: { botId: chat.botId, threadId: chat.threadId, ...(chat.update ? { addedIds: [] } : {}) },
          before: chat.before, written: "", name: chat.name, fingerprint: fingerprintKey(ctx, chat.itemKey), previous: chat.stored,
        });
      }
    });
    const byBot = new Map<string, ImportedThreadInput[]>();
    for (const chat of chats) {
      if (chat.update) continue;
      byBot.set(chat.botId, [...(byBot.get(chat.botId) ?? []), chat.thread]);
    }
    for (const [botId, inputs] of byBot) ctx.ports.threads.create(botId, inputs);
    ctx.ports.threads.append(parts.map((part) => {
      const finished = part.to === part.chat.messages.length;
      const slice = part.chat.messages.slice(part.from, part.to);
      if (part.chat.update) part.chat.addedIds.push(...slice.map((message) => message.id));
      return { threadId: part.chat.threadId, messages: slice, activeLeafId: finished ? part.chat.leaf : slice.at(-1)?.id ?? null };
    }));
    done += count;
    const finishedChats = new Set(parts.filter((part) => part.to === part.chat.messages.length).map((part) => part.chat));
    ctx.db.transaction(() => {
      for (const chat of chats) {
        const written = conversationHash(ctx.ports.threads.state(chat.botId, chat.threadId)) ?? "";
        const target = { botId: chat.botId, threadId: chat.threadId, ...(chat.update ? { addedIds: chat.addedIds } : {}) };
        ctx.db.updateReceipt(ctx.jobId, chat.itemKey, { written, ...(chat.update ? { target } : {}) });
        if (finishedChats.has(chat)) {
          const key = fingerprintKey(ctx, chat.itemKey);
          ctx.db.putFingerprint({ ...key, contentHash: chat.contentHash, target: { botId: chat.botId, threadId: chat.threadId }, written, jobId: ctx.jobId, at: ctx.now() });
        }
      }
      ctx.db.saveCursor(ctx.jobId, { fast: true, conv: next.conv, msg: next.msg, done });
    });
    parts = [];
    count = 0;
    hooks.progress(done);
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    return hooks.stop();
  };

  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  let index = -1;
  try {
    for await (const raw of lines) {
      index++;
      if (index < cursor.conv || !raw.trim()) continue;
      const { agentRef, conversation } = JSON.parse(raw) as SpoolLine;
      const botId = bots[agentRef];
      if (!botId) continue;
      const chat = openChat(ctx, agentRef, botId, conversation);
      if (!chat) continue;
      let from = index === cursor.conv ? Math.min(cursor.msg, chat.messages.length) : 0;
      while (from < chat.messages.length) {
        const to = Math.min(chat.messages.length, from + size - count);
        parts.push({ chat, from, to });
        count += to - from;
        from = to;
        if (count >= size) {
          const stop = await flush(to === chat.messages.length ? { conv: index + 1, msg: 0 } : { conv: index, msg: to });
          if (stop) return stop === "cancel" ? "cancelled" : "paused";
        }
      }
    }
    if (parts.length) await flush({ conv: index + 1, msg: 0 });
  } finally {
    lines.close();
  }
  return "done";
}

/** Null when the chat has nothing to write: skipped by the re-import rule, or empty. */
function openChat(ctx: ApplyContext, agentRef: string, botId: string, conversation: ImportConversation): OpenChat | null {
  const itemKey = `${agentRef}/chat/${conversation.ref}`;
  const title = redact(conversation.title).replace(/\s+/g, " ").slice(0, 200) || UNTITLED_TASK;
  const contentHash = hashOf([conversation.title, conversation.activeLeafRef, conversation.messages.map((message) => [message.ref, message.parentRef, message.text])]);
  const receipt = ctx.db.receipt(ctx.jobId, itemKey);
  let threadId: string;
  let update = false;
  let keptBoth = false;
  let stored: Fingerprint | null = null;
  let before: OpenChat["before"] = null;
  if (receipt) {
    threadId = text(receipt.target.threadId);
    update = receipt.action === "updated";
    keptBoth = receipt.keptBoth === true;
    stored = receipt.previous;
    before = receipt.before as OpenChat["before"];
  } else {
    const found = previousFor(ctx, fingerprintKey(ctx, itemKey), botId);
    stored = found.stored;
    const oldThread = found.previous ? text(found.previous.target.threadId) : "";
    const state = found.previous ? ctx.ports.threads.state(botId, oldThread) : null;
    const decision = decide(found.previous, contentHash, conversationHash(state));
    if (decision === "skip") return null;
    update = decision === "update";
    keptBoth = decision === "keep-both";
    threadId = update ? oldThread : stableId(ctx.jobId, itemKey);
    if (update) before = { activeLeafId: state?.activeLeafId ?? null };
  }
  const built = chatMessages(conversation, threadId, ctx.now());
  let messages = built.messages;
  if (update) {
    const have = ctx.ports.threads.messageIds(threadId);
    const addedBefore = new Set(Array.isArray(receipt?.target.addedIds) ? receipt!.target.addedIds.filter((id): id is string => typeof id === "string") : []);
    messages = messages.filter((message) => !have.has(message.id) || addedBefore.has(message.id));
  }
  if (!messages.length) {
    if (update && !receipt) {
      const key = fingerprintKey(ctx, itemKey);
      const written = conversationHash(ctx.ports.threads.state(botId, threadId)) ?? "";
      ctx.db.putFingerprint({ ...key, contentHash, target: { botId, threadId }, written, jobId: ctx.jobId, at: ctx.now() });
    }
    return null;
  }
  const first = messages[0]!.at;
  const last = messages.reduce((max, message) => Math.max(max, message.at), first);
  return {
    itemKey,
    name: title,
    botId,
    threadId,
    update,
    keptBoth,
    thread: {
      threadId,
      title,
      createdAt: Number.isFinite(conversation.createdAt) ? conversation.createdAt! : first,
      updatedAt: Number.isFinite(conversation.updatedAt) ? conversation.updatedAt! : last,
      imported: { kind: ctx.source.kind, label: ctx.label },
    },
    messages,
    leaf: built.leaf,
    contentHash,
    stored,
    before,
    addedIds: update && Array.isArray(receipt?.target.addedIds) ? receipt!.target.addedIds.filter((id): id is string => typeof id === "string") : [],
    receipt,
  };
}

function nextSteps(): ImportNextSteps {
  return { addKey: [], allowSkill: [], connectAgain: [], resumeRoutine: [] };
}

/** Counts and next steps from what the job wrote. Channels are never connected: they only go to Connect again. */
export function buildReport(ctx: Pick<ApplyContext, "db" | "jobId" | "ports" | "agents">, bots: Record<string, string>, leftovers: ImportLeftover[]): ImportReport {
  const report: ImportReport = { added: 0, updated: 0, keptBoth: 0, leftovers, next: nextSteps() };
  const botName = (botId: string) => ctx.ports.bots.name(botId);
  for (const receipt of ctx.db.receipts(ctx.jobId)) {
    if (receipt.kind === "bot") continue;
    if (receipt.keptBoth) report.keptBoth += 1;
    else if (receipt.action === "updated") report.updated += 1;
    else report.added += 1;
    const botId = text(receipt.target.botId);
    if (receipt.kind === "tool") {
      const keys = Array.isArray(receipt.target.keys) ? receipt.target.keys.filter((key): key is string => typeof key === "string") : [];
      if (keys.length) report.next.addKey.push({ botId, botName: botName(botId), tool: text(receipt.target.name), keys });
    } else if (receipt.kind === "skill" && receipt.target.flagged === true) {
      report.next.allowSkill.push({ botId, botName: botName(botId), skill: text(receipt.target.name) });
    } else if (receipt.kind === "routine") {
      report.next.resumeRoutine.push({ botId, botName: botName(botId), routine: receipt.name });
    }
  }
  for (const agent of ctx.agents) {
    const botId = bots[agent.ref];
    if (!botId) continue;
    for (const channel of agent.channels) {
      report.next.connectAgain.push({ botId, botName: botName(botId), channel: channel.name?.trim() || channel.kind });
    }
  }
  return report;
}
