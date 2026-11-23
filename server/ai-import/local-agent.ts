import { join, relative } from "node:path";

import type { ImportLeftover, ImportRoutine, ImportSkill, ImportTool } from "../../shared/ai-import/bundle.ts";
import { mask, redactSecretsInText } from "../../shared/redact.ts";
import { replaceUntilStable } from "../../shared/replace-until-stable.ts";
import { copyTree, isFile, isRecord, listDirectories } from "./local-fs.ts";

/** Security invariant: the entry names the keys a tool needs and never holds a key. Env and header values are dropped;
 * credentials in the url, the args and the command are removed or masked, and their names join `needsKey`. */
export function toolFromConfig(name: string, config: unknown): ImportTool | null {
  if (!isRecord(config)) return null;
  const url = typeof config.url === "string" && config.url ? config.url : undefined;
  const command = typeof config.command === "string" && config.command ? config.command : undefined;
  const needsKey = [...(isRecord(config.env) ? Object.keys(config.env) : []), ...(isRecord(config.headers) ? Object.keys(config.headers) : [])];
  const noteFor = (transport: ImportTool["transport"]): Note => (raw) => {
    const key = keyName(raw, transport);
    if (key) needsKey.push(key);
  };
  if (url) {
    const clean = cleanUrl(url, noteFor("http"));
    return { ref: `mcp/${name}`, name, transport: "http", url: clean, needsKey: [...new Set(needsKey)] };
  }
  if (!command) return null;
  const note = noteFor("stdio");
  const cleanCommand = redactSecretsInText(command);
  if (cleanCommand !== command) note(FALLBACK_KEY);
  const args = Array.isArray(config.args) ? cleanArgs(config.args.filter((arg): arg is string => typeof arg === "string"), note) : undefined;
  return { ref: `mcp/${name}`, name, transport: "stdio", command: cleanCommand, ...(args ? { args } : {}), needsKey: [...new Set(needsKey)] };
}

type Note = (name: string) => void;

const FALLBACK_KEY = "API_KEY";

const SECRET_LAST_WORDS = new Set([
  "key", "keys", "apikey", "accesskey", "secretkey", "privatekey",
  "token", "tokens", "apitoken", "accesstoken", "authtoken",
  "secret", "secrets", "clientsecret",
  "password", "passwd", "pwd", "pass", "passphrase",
  "auth", "authorization", "bearer", "jwt",
  "sig", "signature", "credential", "credentials",
]);

/** By its last word: `api_key`, `X-Amz-Signature` and `accessToken` name a secret; `key_file`, `token_url` and `keyword` do not. */
function isSecretName(name: string): boolean {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const last = words.at(-1);
  return last !== undefined && SECRET_LAST_WORDS.has(last);
}

/** `${NAME}`, `$NAME`, `{env:NAME}` or `<your key>`, alone or after an auth scheme, points at a key and is not one. */
const PLACEHOLDER = /^(?:(?:Bearer|Basic|Token)\s+)?(?:\$\{[^}]*\}|\$[A-Za-z_]\w*|\{env:[^}]*\}|<[^<>]*>)$/i;

const holdsValue = (value: string): boolean => value.trim() !== "" && !PLACEHOLDER.test(value.trim());

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;

/** Import writes a stdio tool's keys as env names and an http tool's keys as header names, so each must be valid there. */
function keyName(raw: string, transport: ImportTool["transport"]): string {
  const name = raw.replace(/^-+/, "");
  if (transport === "http" && HEADER_NAME.test(name)) return name;
  const env = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
  return /^\d/.test(env) ? `_${env}` : env;
}

/** Drops the userinfo and the value of each secret-named query or fragment parameter. A clean address comes back unchanged. */
function cleanUrl(raw: string, note: Note): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return redactSecretsInText(raw);
  }
  let changed = false;
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
    note("Authorization");
    changed = true;
  }
  const search = cleanParams(url.search, note);
  if (search !== url.search) {
    url.search = search;
    changed = true;
  }
  const hash = cleanParams(url.hash, note);
  if (hash !== url.hash) {
    url.hash = hash;
    changed = true;
  }
  return redactSecretsInText(changed ? url.href : raw);
}

function cleanParams(part: string, note: Note): string {
  if (part.length < 2) return part;
  const pairs = part.slice(1).split("&").map((pair) => {
    const at = pair.indexOf("=");
    if (at < 0) return pair;
    const name = decodeParam(pair.slice(0, at));
    if (!isSecretName(name) || !holdsValue(decodeParam(pair.slice(at + 1)))) return pair;
    note(name);
    return pair.slice(0, at + 1);
  });
  return `${part.charAt(0)}${pairs.join("&")}`;
}

function decodeParam(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

const FLAG = /^--?([A-Za-z][\w.-]*)$/;
/** `--key ./server.key`: a file that holds the key, not the key. */
const PATH = /^(?:\.{0,2}[\\/]|~[\\/]|[A-Za-z]:[\\/])/;
const ASSIGNMENT = /^(-{0,2}[A-Za-z_][\w.-]*)=(.*)$/s;
const HEADER_LINE = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)(\s*:\s*)(.+)$/s;
const ADDRESS = /^[a-z][a-z0-9+.-]*:\/\//i;

function cleanArgs(args: string[], note: Note): string[] {
  return args.map((arg, index) => {
    const previous = args[index - 1];
    const flag = previous === undefined ? null : (FLAG.exec(previous)?.[1] ?? null);
    if (flag !== null && isSecretName(flag) && !arg.startsWith("-")) {
      if (!holdsValue(arg) || PATH.test(arg)) return arg;
      note(flag);
      return mask(arg);
    }
    const assignment = ASSIGNMENT.exec(arg);
    if (assignment) {
      const [, key = "", value = ""] = assignment;
      if (isSecretName(key) && holdsValue(value)) {
        note(key);
        return `${key}=${mask(value)}`;
      }
    }
    if (ADDRESS.test(arg)) return cleanUrl(arg, note);
    const header = HEADER_LINE.exec(arg);
    if (header) {
      const [, key = "", separator = "", value = ""] = header;
      if (isSecretName(key) && holdsValue(value)) {
        note(key);
        return `${key}${separator}${mask(value)}`;
      }
    }
    const redacted = redactSecretsInText(arg);
    if (redacted !== arg) note(flag !== null && previous?.startsWith("--") ? flag : FALLBACK_KEY);
    return redacted;
  });
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

export const stripHtmlComments = (text: string): string => replaceUntilStable(text, /<!--[\s\S]*?-->/g, "");

/** One entry per top-level bullet with its continuation lines; a file with no bullets gives one entry per paragraph. Headings are dropped. */
export function markdownEntries(text: string): string[] {
  const lines = stripHtmlComments(text).split(/\r?\n/).filter((line) => !/^\s{0,3}#{1,6}\s/.test(line));
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
