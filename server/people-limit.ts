// Security: the free limit only ever refuses a new person. Nobody who holds a place loses it to the limit: not when a
// Premium key ends, not when the saved key cannot be read, not on the first start of a server that already has more.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { FREE_PEOPLE_LIMIT, type JoinedPerson, type PeoplePlanStatus } from "../shared/people-plan.ts";
import { PREMIUM_UPGRADE_URL } from "../shared/plan-keys.ts";
import { allowedScopes, parseAllowList, type SignInAllowList } from "./account-signin.ts";
import { writeFileAtomic } from "./atomic.ts";
import { entitled, hostedWorkspaceConfigured, loadEnterpriseLayer } from "./enterprise.ts";
import { premiumKeyStatus, premiumUnlimited, savePlanKey, TEAM_KEY_ENV, type PlanKeyOptions, type PlanKeyRefusal } from "./plan-key.ts";
import { signInFromEnv } from "./sign-in-env.ts";

/** Everyone who signed in with an email here, and everyone who held a place when this file was first written. */
export const PEOPLE_FILE = "sign-in-people.json";

export interface PeopleSession {
  id: string;
  email?: string;
  token?: true;
  scopes?: readonly string[];
  lastSeenAt?: number;
}

type ListsChange = Partial<Record<keyof SignInAllowList, string[]>>;

const address = (email: string) => email.trim().toLowerCase();

function listed(lists: SignInAllowList): Set<string> {
  return new Set([...lists.admins, ...lists.members].filter((entry) => !entry.startsWith("@")).map(address));
}

/** Who holds a place: each listed address, each address with a live session, each kept address. Never a device paired by
 * code (it has no address), never an API token, never someone the lists no longer let in. */
export function peopleHolding(lists: SignInAllowList, sessions: readonly PeopleSession[], kept: readonly string[]): Set<string> {
  const people = listed(lists);
  for (const session of sessions) {
    if (session.token || !session.email) continue;
    const email = address(session.email);
    if (allowedScopes(email, lists)) people.add(email);
  }
  for (const email of kept) if (allowedScopes(email, lists)) people.add(address(email));
  return people;
}

type KeptRead = { state: "ok"; people: string[] } | { state: "missing" } | { state: "unreadable" };

function readKept(dataDir: string): KeptRead {
  const file = join(dataDir, PEOPLE_FILE);
  if (!existsSync(file)) return { state: "missing" };
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const people: unknown = Reflect.get(Object(parsed), "people");
    if (!Array.isArray(people) || !people.every((entry) => typeof entry === "string")) return { state: "unreadable" };
    return { state: "ok", people: people.map(address) };
  } catch {
    return { state: "unreadable" };
  }
}

function writeKept(dataDir: string, people: Iterable<string>): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileAtomic(join(dataDir, PEOPLE_FILE), `${JSON.stringify({ version: 1, people: [...new Set(people)].sort() }, null, 2)}\n`, { mode: 0o600 });
}

/** Live sessions as sessions.json holds them, for the CLI, which runs beside the server or without it. */
export function sessionsFromFile(dataDir: string, now: number = Date.now()): PeopleSession[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dataDir, "sessions.json"), "utf8"));
    const sessions: unknown = Reflect.get(Object(parsed), "sessions");
    if (!Array.isArray(sessions)) return [];
    return sessions.flatMap((raw: unknown) => {
      const record = Object(raw) as Record<string, unknown>;
      if (typeof record.email !== "string" || record.token === true || typeof record.expiresAt !== "number" || record.expiresAt <= now) return [];
      return [{ id: String(record.id), email: record.email }];
    });
  } catch {
    return [];
  }
}

export interface PeopleLimitOptions extends PlanKeyOptions {
  /** The sign-in lists in force: config.json, with a list the environment names in its place. */
  lists(): SignInAllowList;
  sessions(): readonly PeopleSession[];
  revoke(sessionId: string): void;
  /** False on a Team Cloud, a hosted workspace with portal membership and My Cloud: the server does not decide who comes in. */
  applies: boolean;
  /** An Enterprise licence grants `people-unlimited`. */
  enterpriseUnlimited(): boolean;
  now?: () => number;
}

export interface PeopleLimit {
  /** True when the free plan has no place for this new person. Null-safe for an address the lists do not let in. */
  refuses(email: string): boolean;
  /** Lets the person in and keeps their place, or refuses them; check and record happen in one step. */
  admit(email: string): "full" | null;
  /** Before Settings saves the lists: a refusal when the change adds people past the free limit, else the step to run
   * once they are saved (it ends the sessions of each address taken off and frees their places). */
  listsChanging(asked: ListsChange | undefined): { refusal: { limit: number } } | { saved(): void };
  /** Takes off someone who joined through an `@domain` entry: their sessions end and their place is free. */
  removeJoined(email: string): "removed" | "listed" | "unknown";
  /** Saves a Premium key from Settings; never over a key the environment sets. */
  saveKey(raw: string): { ok: true } | { ok: false; reason: PlanKeyRefusal | "environment" };
  status(): PeoplePlanStatus;
}

export function createPeopleLimit(options: PeopleLimitOptions): PeopleLimit {
  const now = options.now ?? Date.now;
  const kept = (): string[] => {
    const read = readKept(options.dataDir);
    return read.state === "ok" ? read.people : [];
  };
  const keep = (people: Iterable<string>) => {
    try {
      writeKept(options.dataDir, people);
    } catch (error) {
      console.warn(`could not save who holds a place to sign in: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const key = () => premiumKeyStatus(options, now());
  const enterprise = () => options.applies && options.enterpriseUnlimited();
  const limited = () => options.applies && !enterprise() && !premiumUnlimited(key());
  const holding = () => peopleHolding(options.lists(), options.sessions(), kept());
  const endSessions = (emails: ReadonlySet<string>) => {
    for (const session of options.sessions()) if (session.email && !session.token && emails.has(address(session.email))) options.revoke(session.id);
  };

  if (options.applies && readKept(options.dataDir).state !== "ok") keep(peopleHolding(options.lists(), options.sessions(), []));

  const refuses = (email: string) => {
    const person = address(email);
    if (!limited() || !allowedScopes(person, options.lists())) return false;
    const people = holding();
    return !people.has(person) && people.size >= FREE_PEOPLE_LIMIT;
  };

  return {
    refuses,
    admit(email) {
      if (refuses(email)) return "full";
      const person = address(email);
      if (options.applies && allowedScopes(person, options.lists())) {
        const people = kept();
        if (!people.includes(person)) keep([...people, person]);
      }
      return null;
    },
    listsChanging(asked) {
      if (!asked || !options.applies) return { saved() {} };
      const before = options.lists();
      const pinned = signInFromEnv(options.env ?? process.env);
      // A save replaces the whole section: a list left out is empty afterwards, unless the environment names it.
      const after: SignInAllowList = {
        admins: asked.admins ? parseAllowList(asked.admins.join(",")) : pinned.admins ?? [],
        members: asked.members ? parseAllowList(asked.members.join(",")) : pinned.members ?? [],
      };
      const nextListed = listed(after);
      const removed = new Set([...listed(before)].filter((email) => !nextListed.has(email)));
      const sessions = options.sessions();
      const people = kept();
      const current = peopleHolding(before, sessions, people);
      const next = peopleHolding(after, sessions.filter((session) => !session.email || !removed.has(address(session.email))), people.filter((email) => !removed.has(email)));
      const adds = [...next].some((email) => !current.has(email));
      if (adds && next.size > FREE_PEOPLE_LIMIT && limited()) return { refusal: { limit: FREE_PEOPLE_LIMIT } };
      return {
        saved() {
          if (removed.size) endSessions(removed);
          const lists = options.lists();
          const was = kept();
          const stay = was.filter((email) => !removed.has(email) && allowedScopes(email, lists));
          if (stay.length !== was.length) keep(stay);
        },
      };
    },
    removeJoined(email) {
      const person = address(email);
      if (listed(options.lists()).has(person)) return "listed";
      const people = kept();
      const hadSession = options.sessions().some((session) => session.email && !session.token && address(session.email) === person);
      if (!people.includes(person) && !hadSession) return "unknown";
      endSessions(new Set([person]));
      if (people.includes(person)) keep(people.filter((entry) => entry !== person));
      return "removed";
    },
    saveKey(raw) {
      if ((options.env ?? process.env)[TEAM_KEY_ENV]?.trim()) return { ok: false, reason: "environment" };
      const saved = savePlanKey(options, raw, now());
      return saved.ok ? { ok: true } : saved;
    },
    status() {
      const keyStatus = options.applies ? key() : null;
      const plan = enterprise() ? "unlimited" : premiumUnlimited(keyStatus) ? "premium" : "free";
      if (!options.applies) return { applies: false, plan, people: 0, limit: FREE_PEOPLE_LIMIT, full: false, joined: [], key: null, upgradeUrl: PREMIUM_UPGRADE_URL };
      const lists = options.lists();
      const sessions = options.sessions();
      const people = peopleHolding(lists, sessions, kept());
      const byAddress = listed(lists);
      const joined = [...people].filter((email) => !byAddress.has(email)).sort().map((email): JoinedPerson => {
        const devices = sessions.filter((session) => session.email && !session.token && address(session.email) === email);
        const seen = devices.map((session) => session.lastSeenAt).filter((at): at is number => typeof at === "number");
        return {
          email,
          via: [...lists.admins, ...lists.members].find((entry) => entry.startsWith("@") && email.endsWith(entry)) ?? "",
          role: allowedScopes(email, lists)?.includes("admin") ? "admin" : "member",
          lastSeenAt: seen.length ? Math.max(...seen) : null,
          devices: devices.length,
        };
      });
      return {
        applies: true, plan, people: people.size, limit: FREE_PEOPLE_LIMIT,
        full: plan === "free" && people.size >= FREE_PEOPLE_LIMIT,
        joined, key: keyStatus, upgradeUrl: PREMIUM_UPGRADE_URL,
      };
    },
  };
}

/** For `seira access add`, which edits config.json beside a running server or without one: why the new lists would pass
 * the free limit, or null. `before` and `after` are config.json's lists; a list the environment names stays in force. */
export async function accessChangeRefusal(dataDir: string, before: SignInAllowList, after: SignInAllowList, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const pinned = signInFromEnv(env);
  const inForce = (lists: SignInAllowList): SignInAllowList => ({ admins: pinned.admins ?? lists.admins, members: pinned.members ?? lists.members });
  await loadEnterpriseLayer({ env });
  const people = createPeopleLimit({
    dataDir, env, lists: () => inForce(before), sessions: () => sessionsFromFile(dataDir), revoke() {},
    applies: env.SEIRA_CLOUD_ROLE === undefined && !hostedWorkspaceConfigured(env),
    enterpriseUnlimited: () => entitled("people-unlimited"),
  });
  const change = people.listsChanging(inForce(after));
  return "refusal" in change
    ? `this server's free plan includes ${change.refusal.limit} people; add a Premium key in Settings → People (or set ${TEAM_KEY_ENV}) to add more`
    : null;
}
