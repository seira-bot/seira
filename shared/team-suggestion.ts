// A team Seira suggests to a new person, as a seira.package with no leader, and the pick the person makes from it. Pure:
// the server builds and reads it, the card in the chat shows it through packageDetails.
import { TEAM_BOT_NAME_MAX, TEAM_NAME_MAX } from "../packages/phone-protocol/src/team-suggestion.ts";
import { BOT_COLORS, clip, uniqueSlug } from "./grok-import.ts";
import { PACKAGE_FORMAT, PACKAGE_V2_VERSION, parsePackageDocument, type PackageDocument } from "./package-format.ts";

export const SUGGESTED_BOTS_MAX = 8;
export const SUGGESTED_CHATS_MAX = 4;

export interface SuggestedBot {
  name: string;
  /** A short title, such as "Bookkeeper". */
  role: string;
  /** What the bot does for this person, in one or two sentences. */
  job: string;
  /** The bot's standing instructions; the job stands in when there are none. */
  instructions?: string;
}

export interface TeamSuggestionInput {
  department: string;
  summary: string;
  bots: readonly SuggestedBot[];
  /** Group chats by member bot name. */
  groupChats?: ReadonlyArray<{ name: string; members: readonly string[] }>;
}

export class TeamSuggestionError extends Error {}

const line = (value: string) => value.replace(/\s+/g, " ").trim();
const nameKey = (value: string) => line(value).toLowerCase();

/** The package a suggestion stands for. It has no leader and no routines, skills or apps. */
export function suggestionPackage(input: TeamSuggestionInput): PackageDocument {
  const department = clip(line(input.department), TEAM_NAME_MAX);
  const summary = clip(input.summary.trim() || `A team for ${department}.`, 2_000);
  if (!department) throw new TeamSuggestionError("The team needs a name.");
  const taken = new Set<string>();
  const keys = new Map<string, string>();
  const agents = input.bots.flatMap((bot, index) => {
    const name = clip(line(bot.name), TEAM_BOT_NAME_MAX);
    const job = clip(bot.job.trim(), 4_000);
    if (!name || !job || keys.has(nameKey(name)) || keys.size >= SUGGESTED_BOTS_MAX) return [];
    const key = uniqueSlug(name, `bot-${index + 1}`, taken, 60);
    keys.set(nameKey(name), key);
    const role = clip(line(bot.role), 200);
    return [{
      key, name, ...(role ? { title: role } : {}), description: job,
      soul: clip((bot.instructions ?? "").trim() || job, 20_000),
      appearance: { color: BOT_COLORS[keys.size % BOT_COLORS.length]! },
    }];
  });
  if (!agents.length) throw new TeamSuggestionError("The team needs at least one bot with a name and a job.");
  const chatKeys = new Set<string>();
  const rooms = (input.groupChats ?? []).flatMap((chat, index) => {
    const members = [...new Set(chat.members.flatMap((member) => keys.get(nameKey(member)) ?? []))];
    const name = clip(line(chat.name), 100);
    if (!name || members.length < 2 || chatKeys.size >= SUGGESTED_CHATS_MAX) return [];
    return [{ key: uniqueSlug(name, `chat-${index + 1}`, chatKeys, 60), name, members, defaultResponder: { kind: "mentions" as const } }];
  });
  try {
    return parsePackageDocument({
      format: PACKAGE_FORMAT,
      version: PACKAGE_V2_VERSION,
      package: {
        id: uniqueSlug(department, "team", new Set(), 70),
        release: "1.0.0",
        name: department,
        tagline: clip(line(summary), 160),
        summary,
        category: "Suggested",
        author: { name: "Seira" },
        license: "Personal use",
        outcomes: [clip(line(summary), 240)],
        setupMinutes: 5,
        requirements: { apps: [], capabilities: [] },
        team: { name: department, brief: summary },
        agents,
        ...(rooms.length ? { rooms } : {}),
      },
    }, { trust: "file" });
  } catch (error) {
    throw new TeamSuggestionError(error instanceof Error ? error.message : "The team could not be built.");
  }
}

export interface SuggestionPick {
  /** Keys of the bots to keep; every bot when absent. */
  keep?: readonly string[];
  /** New names by bot key; an empty name keeps the suggested one. */
  names?: Readonly<Record<string, string>>;
  department?: string;
}

/** The suggestion as the person edited it: only the kept bots with their names, one department, and only the group
 * chats that keep at least two members. */
export function pickSuggestion(source: unknown, pick: SuggestionPick = {}): PackageDocument {
  const document = parsePackageDocument(source, { trust: "file" });
  const pkg = document.package;
  const keep = pick.keep ? new Set(pick.keep) : null;
  const used = new Set<string>();
  const agents = pkg.agents.filter((agent) => !keep || keep.has(agent.key)).map((agent) => {
    const base = clip(line(pick.names?.[agent.key] ?? ""), TEAM_BOT_NAME_MAX) || agent.name;
    let name = base;
    for (let n = 2; used.has(nameKey(name)); n += 1) name = clip(`${base} ${n}`, TEAM_BOT_NAME_MAX);
    used.add(nameKey(name));
    return { ...agent, name };
  });
  if (!agents.length) throw new TeamSuggestionError("Keep at least one bot.");
  const kept = new Set(agents.map((agent) => agent.key));
  const rooms = (pkg.rooms ?? []).flatMap((room) => {
    const members = room.members.filter((member) => kept.has(member));
    return members.length >= 2 ? [{ ...room, members, defaultResponder: { kind: "mentions" as const } }] : [];
  });
  const department = clip(line(pick.department ?? ""), TEAM_NAME_MAX) || pkg.team!.name;
  const rest: Partial<typeof pkg> = { ...pkg };
  delete rest.rooms;
  return parsePackageDocument({
    ...document,
    package: { ...rest, name: department, team: { ...pkg.team!, name: department }, agents, ...(rooms.length ? { rooms } : {}) },
  }, { trust: "file" });
}
