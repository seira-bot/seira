import { join, relative } from "node:path";

import type { ImportLeftover, ImportRoutine, ImportSkill, ImportTool } from "../../shared/ai-import/bundle.ts";
import { copyTree, isFile, isRecord, listDirectories } from "./local-fs.ts";

/** Keeps the names of env values and headers, never the values. */
export function toolFromConfig(name: string, config: unknown): ImportTool | null {
  if (!isRecord(config)) return null;
  const url = typeof config.url === "string" && config.url ? config.url : undefined;
  const command = typeof config.command === "string" && config.command ? config.command : undefined;
  if (!url && !command) return null;
  const needsKey = [...(isRecord(config.env) ? Object.keys(config.env) : []), ...(isRecord(config.headers) ? Object.keys(config.headers) : [])];
  const args = Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === "string") : undefined;
  return { ref: `mcp/${name}`, name, transport: url ? "http" : "stdio", ...(url ? { url } : { command, ...(args ? { args } : {}) }), needsKey };
}

/** Skill folders sit at `<root>/<name>/SKILL.md` or one level deeper in a category folder. Each is copied into `stagingDir`. */
export async function collectSkills(root: string, stagingDir: string): Promise<{ skills: ImportSkill[]; leftovers: ImportLeftover[] }> {
  const skills: ImportSkill[] = [];
  const leftovers: ImportLeftover[] = [];
  const folders: string[] = [];
  for (const first of await listDirectories(root)) {
    const dir = join(root, first);
    if (await isFile(join(dir, "SKILL.md"))) folders.push(dir);
    else for (const second of await listDirectories(dir)) if (await isFile(join(dir, second, "SKILL.md"))) folders.push(join(dir, second));
  }
  for (const dir of folders) {
    const rel = relative(root, dir).split("\\").join("/");
    const name = rel.split("/").at(-1) ?? rel;
    const target = join(stagingDir, "skills", String(skills.length), name);
    try {
      await copyTree(dir, target);
      skills.push({ ref: `skills/${rel}`, name, dir: target });
    } catch {
      leftovers.push({ ref: `skills/${rel}`, kind: "skill", name, reason: "unreadable" });
    }
  }
  return { skills, leftovers };
}

export function everySchedule(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes % 1440 === 0) return `every ${minutes / 1440}d`;
  if (minutes % 60 === 0) return `every ${minutes / 60}h`;
  return `every ${minutes}m`;
}

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** A 5-field cron line, "every <n><m|h|d>" or an ISO date; null for anything else, such as a relative "in 30m". */
export function textSchedule(text: string): string | null {
  const value = text.trim();
  if (/^[\d*/,\-A-Za-z?]+(?:\s+[\d*/,\-A-Za-z?]+){4}$/.test(value)) return value;
  const every = /^every\s+(\d+)\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?)$/i.exec(value);
  if (every) {
    const unit = (every[2] ?? "m").charAt(0).toLowerCase() as keyof typeof UNIT_MS;
    return everySchedule(Number(every[1]) * UNIT_MS[unit]);
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return null;
}

export function routineFrom(ref: string, name: string, schedule: string | null, prompt: string): { routine?: ImportRoutine; leftover?: ImportLeftover } {
  if (schedule === null) return { leftover: { ref, kind: "routine", name, reason: "unsupported" } };
  return { routine: { ref, name, schedule, prompt } };
}

/** One entry per top-level bullet with its continuation lines; a file with no bullets gives one entry per paragraph. Headings are dropped. */
export function markdownEntries(text: string): string[] {
  const lines = text.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/).filter((line) => !/^\s{0,3}#{1,6}\s/.test(line));
  const bullets: string[] = [];
  let hasBullet = false;
  for (const line of lines) {
    if (/^[-*]\s+\S/.test(line)) {
      hasBullet = true;
      bullets.push(line.replace(/^[-*]\s+/, ""));
    } else if (hasBullet && /^\s+\S/.test(line) && bullets.length > 0) bullets[bullets.length - 1] += `\n${line.trim()}`;
  }
  const entries = hasBullet ? bullets : lines.join("\n").split(/\n\s*\n/);
  return entries.map((entry) => entry.trim()).filter(Boolean);
}
