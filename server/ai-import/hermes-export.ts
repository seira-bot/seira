import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";

import { emptyAgent, type ImportAgent, type ImportEvent, type ImportLeftover, type ImportMemoryItem } from "../../shared/ai-import/bundle.ts";
import { EXPORT_CHANNEL, EXPORT_INSTANCE, EXPORT_KEY, HERMES_EXPORT, HERMES_EXPORT_LIMITS, REBUILT_FOLDERS, refusedEntry } from "../../shared/ai-import/hermes-export.ts";
import { safeArchivePath } from "../zip-archive.ts";
import { entriesSeed, fingerprintOf, peekHead } from "./export-common.ts";
import { textSchedule } from "./local-agent.ts";
import { isRecord } from "./local-fs.ts";
import type { ImportEntry, ImportFiles, ReaderContext } from "./reader.ts";
import { ImportUploadError } from "./zip-reader.ts";

const SKILL_FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

const broken = (): ImportUploadError => new ImportUploadError("bad-export");

/** The manifest at the root, or in the one folder a desktop "Compress" puts around it. Null when there is none. */
function manifestEntry(entries: readonly ImportEntry[]): { entry: ImportEntry; base: string } | null {
  const found = entries.filter((entry) => entry.name === HERMES_EXPORT.manifest || /^[^/]+\/[^/]+$/.test(entry.name) && entry.name.endsWith(`/${HERMES_EXPORT.manifest}`));
  const root = found.find((entry) => entry.name === HERMES_EXPORT.manifest);
  if (root) return { entry: root, base: "" };
  const [only] = found;
  return found.length === 1 && only ? { entry: only, base: only.name.slice(0, -HERMES_EXPORT.manifest.length) } : null;
}

export async function isHermesExport(files: ImportFiles): Promise<boolean> {
  const found = manifestEntry(files.entries);
  return found !== null && (await peekHead(files, found.entry.name)).includes(`"${HERMES_EXPORT.format}"`);
}

/** Security invariant: one key file or nested archive anywhere refuses the whole export before any entry is opened. */
function refuseUnsafe(entries: readonly ImportEntry[]): void {
  const reasons = new Set(entries.map((entry) => refusedEntry(entry.name)));
  if (reasons.has("secret")) throw new ImportUploadError("secret-file");
  if (reasons.has("archive")) throw new ImportUploadError("unsafe-archive");
}

async function readManifest(files: ImportFiles, entry: ImportEntry): Promise<unknown> {
  if (entry.size > HERMES_EXPORT_LIMITS.manifestBytes) throw broken();
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of await files.open(entry.name)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += buffer.length;
    if (length > HERMES_EXPORT_LIMITS.manifestBytes) throw broken();
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8").replace(/^﻿/, ""));
  } catch {
    throw broken();
  }
}

function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > max) throw broken();
  return value;
}

function list(value: unknown, max: number): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) throw broken();
  return value;
}

function timeZoneOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "" || value.length > 64) return undefined;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function entries(value: unknown, file: string, key: string, leftovers: ImportLeftover[]): ImportMemoryItem[] {
  const items: ImportMemoryItem[] = [];
  list(value, HERMES_EXPORT_LIMITS.entries).forEach((item, index) => {
    if (typeof item !== "string") throw broken();
    const ref = `${file}#${index}`;
    const text = item.trim();
    if (text.length > HERMES_EXPORT_LIMITS.entryChars) leftovers.push({ ref: `${key}/${ref}`, kind: "memory", reason: "too-large" });
    else if (text) items.push({ ref, text });
  });
  return items;
}

function skillFiles(files: ImportFiles, folder: string): ImportEntry[] | null {
  const prefix = `${folder}/`;
  const members: ImportEntry[] = [];
  for (const entry of files.entries) {
    if (!entry.name.startsWith(prefix)) continue;
    const rel = entry.name.slice(prefix.length);
    if (!safeArchivePath(rel)) return null;
    if (rel.split("/").some((part) => REBUILT_FOLDERS.has(part))) continue;
    members.push({ name: rel, size: entry.size });
  }
  return members;
}

async function copySkill(files: ImportFiles, folder: string, members: readonly ImportEntry[], target: string, signal: AbortSignal): Promise<void> {
  for (const member of members) {
    if (signal.aborted) return;
    const to = join(target, ...member.name.split("/"));
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await pipeline(await files.open(`${folder}/${member.name}`), createWriteStream(to, { flags: "wx", mode: 0o600 }));
  }
}

/** Reads the export that the `seira-export` skill makes in Hermes. Keys, MCP servers and chats are never in it. */
export async function* readHermesExport(files: ImportFiles, ctx: ReaderContext): AsyncGenerator<ImportEvent> {
  const found = manifestEntry(files.entries);
  if (!found) throw broken();
  refuseUnsafe(files.entries);
  const manifest = await readManifest(files, found.entry);
  if (!isRecord(manifest) || manifest.format !== HERMES_EXPORT.format || manifest.version !== HERMES_EXPORT.version) throw broken();
  if (!isRecord(manifest.source) || manifest.source.app !== HERMES_EXPORT.app) throw broken();
  const agents = list(manifest.agents, HERMES_EXPORT_LIMITS.agents);
  if (agents.length === 0) throw broken();

  const instance = typeof manifest.source.instance === "string" && EXPORT_INSTANCE.test(manifest.source.instance) ? manifest.source.instance : null;
  const timeZone = timeZoneOf(manifest.source.timeZone);
  yield { type: "source", source: { kind: "hermes", fingerprint: fingerprintOf("hermes-export", instance ?? entriesSeed(files.entries)) } };

  const keys = new Set<string>();
  const parsed = agents.map((raw) => {
    if (!isRecord(raw) || typeof raw.key !== "string" || !EXPORT_KEY.test(raw.key) || keys.has(raw.key)) throw broken();
    keys.add(raw.key);
    const name = optionalText(raw.name, HERMES_EXPORT_LIMITS.nameChars)?.replace(/\s+/g, " ").trim();
    if (!name) throw broken();
    return { raw, key: raw.key, name };
  });

  let done = 0;
  let staged = 0;
  for (const { raw, key, name } of parsed) {
    if (ctx.signal.aborted) return;
    const agent: ImportAgent = emptyAgent(key, name);
    const leftovers: ImportLeftover[] = [];

    const persona = optionalText(raw.persona, HERMES_EXPORT_LIMITS.personaChars)?.trim();
    if (persona) agent.persona = persona;
    agent.aboutYou = entries(raw.aboutYou, "memories/USER.md", key, leftovers);
    agent.memories = entries(raw.memories, "memories/MEMORY.md", key, leftovers);

    const named = new Set<string>();
    for (const path of list(raw.skills, HERMES_EXPORT_LIMITS.skills)) {
      if (typeof path !== "string" || path.length > 200) throw broken();
      const rel = path.replace(/\/+$/, "");
      if (named.has(rel)) continue;
      named.add(rel);
      const folder = rel.startsWith(`agents/${key}/skills/`) ? rel.slice(`agents/${key}/skills/`.length) : "";
      const ref = `skills/${folder || rel}`;
      const leave = (reason: ImportLeftover["reason"]) => leftovers.push({ ref: `${key}/${ref}`, kind: "skill", name: folder || rel, reason });
      const members = SKILL_FOLDER.test(folder) ? skillFiles(files, `${found.base}${rel}`) : null;
      if (!members || !members.some((member) => member.name === "SKILL.md")) {
        leave("unreadable");
        continue;
      }
      if (members.length > HERMES_EXPORT_LIMITS.skillFiles || members.reduce((sum, member) => sum + member.size, 0) > HERMES_EXPORT_LIMITS.skillBytes) {
        leave("too-large");
        continue;
      }
      const dir = join(ctx.stagingDir, "skills", String(staged++), folder);
      try {
        await copySkill(files, `${found.base}${rel}`, members, dir, ctx.signal);
        agent.skills.push({ ref, name: folder, dir });
      } catch {
        leave("unreadable");
      }
    }

    const seen = new Map<string, number>();
    for (const routine of list(raw.routines, HERMES_EXPORT_LIMITS.routines)) {
      if (!isRecord(routine) || typeof routine.name !== "string" || typeof routine.prompt !== "string" || typeof routine.schedule !== "string") throw broken();
      const title = routine.name.replace(/\s+/g, " ").trim().slice(0, HERMES_EXPORT_LIMITS.nameChars) || routine.prompt.trim().split(/\s+/).slice(0, 6).join(" ");
      const count = (seen.get(title) ?? 0) + 1;
      seen.set(title, count);
      const ref = `cron/${title}${count > 1 ? `#${count}` : ""}`;
      const schedule = textSchedule(routine.schedule);
      const prompt = routine.prompt.trim();
      if (prompt.length > HERMES_EXPORT_LIMITS.promptChars) leftovers.push({ ref: `${key}/${ref}`, kind: "routine", name: title, reason: "too-large" });
      else if (!schedule || !prompt) leftovers.push({ ref: `${key}/${ref}`, kind: "routine", name: title, reason: "unsupported" });
      else agent.routines.push({ ref, name: title, schedule, prompt, ...(timeZone ? { timeZone } : {}) });
    }

    for (const channel of new Set(list(raw.channels, HERMES_EXPORT_LIMITS.channels))) {
      if (typeof channel === "string" && EXPORT_CHANNEL.test(channel)) agent.channels.push({ ref: `platforms/${channel}`, kind: channel });
      else leftovers.push({ ref: `${key}/platforms/${agent.channels.length + leftovers.length}`, kind: "channel", reason: "unsupported" });
    }

    yield { type: "agent", agent };
    for (const leftover of leftovers) yield { type: "leftover", leftover };
    yield { type: "progress", done: ++done, total: parsed.length, unit: "items" };
  }
}
