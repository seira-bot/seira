// Security: the free limit only ever refuses a new person. Nobody who holds a place loses it to the limit: not when a
// Premium key ends, not when the saved key cannot be read, not on the first start of a server that already has more.
// A listed address holds a place once Settings or `seira access add` adds it, or once it signs in. An address that only
// the environment, a hand edit of config.json or `seira fleet users` lists is checked when it first signs in. An address
// that the lists no longer let in loses its place, so a list that names it again cannot bring it back unchecked.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { FREE_PEOPLE_LIMIT, type JoinedPerson, type PeoplePlanStatus } from "../shared/people-plan.ts";
import { PREMIUM_UPGRADE_URL } from "../shared/plan-keys.ts";
import { allowedScopes, parseAllowList, type SignInAllowList } from "./account-signin.ts";
import { writeFileAtomic } from "./atomic.ts";
import { ensurePrivateDir } from "./data-dir.ts";
import { entitled, hostedWorkspaceConfigured, loadEnterpriseLayer } from "./enterprise.ts";
import { premiumKeyStatus, premiumUnlimited, savePlanKey, TEAM_KEY_ENV, type PlanKeyOptions, type PlanKeyRefusal } from "./plan-key.ts";
import { signInFromEnv } from "./sign-in-env.ts";

/** Everyone who holds a place: each address that signed in with an email here or that Settings or the CLI added, and,
 * on a data folder from an earlier version, everyone who could sign in when this file was first written. */
export const PEOPLE_FILE = "sign-in-people.json";

/** Every earlier version wrote its messages here on its first start, and this version opens it only after the limit. */
const EARLIER_RUN_FILE = "messages.db";

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

/** Who holds a place: each kept address and each address with a live session. Never a device paired by code (it has no
 * address), never an API token, never someone the lists no longer let in. */
export function peopleHolding(lists: SignInAllowList, sessions: readonly PeopleSession[], kept: readonly string[]): Set<string> {
  const people = new Set<string>();
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
  ensurePrivateDir(dataDir);
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
  /** False on a Team Cloud, a hosted workspace with portal membership and My Cloud: the server does not decide who comes in.
   * The CLI uses peopleLimitApplies(), the same rule. */
  applies: boolean;
  /** An Enterprise licence grants `people-unlimited`. */
  enterpriseUnlimited(): boolean;
  /** The CLI: the running server's environment can name lists that this process cannot see. Every kept address and live
   * session then counts, no place is dropped, and a missing sign-in-people.json stays for the server's first start. */
  partialLists?: boolean;
  now?: () => number;
}

export interface PeopleLimit {
  /** True when the free plan has no place for this person: a listed address with no place counts as new. Null-safe for an
   * address the lists do not let in. */
  refuses(email: string): boolean;
  /** Lets the person in and keeps their place, or refuses them; check and record happen in one step. */
  admit(email: string): "full" | null;
  /** Before Settings or the CLI saves the lists: a refusal when the change adds people past the free limit, else the step
   * to run once they are saved (it gives each added address a place, ends the sessions of each address taken off and
   * frees their places). */
  listsChanging(asked: ListsChange | undefined): { refusal: { limit: number } } | { saved(): void };
  /** Takes off someone who joined through an `@domain` entry: their sessions end and their place is free. */
  removeJoined(email: string): "removed" | "listed" | "unknown";
  /** Saves a Premium key from Settings; never over a key the environment sets. */
  saveKey(raw: string): { ok: true } | { ok: false; reason: PlanKeyRefusal | "environment" };
  status(): PeoplePlanStatus;
}

export function createPeopleLimit(options: PeopleLimitOptions): PeopleLimit {
  const now = options.now ?? Date.now;
  // An unreadable file could name anyone: everyone listed keeps a place while it stays unreadable. So does a missing file
  // in the CLI, where everyone listed gets a place at the server's first start on an earlier data folder.
  const kept = (lists: SignInAllowList = options.lists()): string[] => {
    const read = readKept(options.dataDir);
    return read.state === "ok" ? read.people : read.state === "unreadable" || options.partialLists ? [...listed(lists)] : [];
  };
  /** Changes the saved places; never writes over a file it could not read, so no place in it is lost. */
  const keep = (change: (people: string[]) => string[]) => {
    const read = readKept(options.dataDir);
    if (read.state === "unreadable" || (read.state === "missing" && options.partialLists)) return;
    const was = read.state === "ok" ? read.people : [];
    const next = [...new Set(change(was))];
    if (read.state === "ok" && next.length === was.length && next.every((email) => was.includes(email))) return;
    try {
      writeKept(options.dataDir, next);
    } catch (error) {
      console.warn(`could not save who holds a place to sign in: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const key = () => premiumKeyStatus(options, now());
  const enterprise = () => options.applies && options.enterpriseUnlimited();
  const limited = () => options.applies && !enterprise() && !premiumUnlimited(key());
  const holdingOf = (lists: SignInAllowList, sessions: readonly PeopleSession[], people: readonly string[]) => options.partialLists
    ? new Set([...sessions.flatMap((session) => (session.email && !session.token ? [address(session.email)] : [])), ...people])
    : peopleHolding(lists, sessions, people);
  // Not in the CLI, and not on empty lists, which a config.json that cannot be read leaves: a bad start frees no place.
  const prune = (lists: SignInAllowList) => {
    if (!options.applies || options.partialLists || (!lists.admins.length && !lists.members.length)) return;
    keep((people) => people.filter((email) => allowedScopes(email, lists)));
  };
  const holding = () => {
    const lists = options.lists();
    prune(lists);
    return holdingOf(lists, options.sessions(), kept(lists));
  };
  const endSessions = (emails: ReadonlySet<string>) => {
    for (const session of options.sessions()) if (session.email && !session.token && emails.has(address(session.email))) options.revoke(session.id);
  };

  // The first start on this version: a data folder an earlier version used keeps everyone who could sign in there. A new
  // data folder keeps only who has a live session, so a long list in the environment or config.json gets no places.
  if (options.applies && readKept(options.dataDir).state === "missing") {
    const lists = options.lists();
    keep(() => [...peopleHolding(lists, options.sessions(), existsSync(join(options.dataDir, EARLIER_RUN_FILE)) ? [...listed(lists)] : [])]);
  }
  prune(options.lists());

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
      if (options.applies && allowedScopes(person, options.lists())) keep((people) => [...people, person]);
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
      const beforeListed = listed(before);
      const nextListed = listed(after);
      const removed = new Set([...beforeListed].filter((email) => !nextListed.has(email)));
      const added = [...nextListed].filter((email) => !beforeListed.has(email));
      const sessions = options.sessions();
      prune(before);
      const people = kept(before);
      const current = holdingOf(before, sessions, people);
      const next = holdingOf(after, sessions.filter((session) => !session.email || !removed.has(address(session.email))), people.filter((email) => !removed.has(email)));
      for (const email of added) next.add(email);
      const adds = [...next].some((email) => !current.has(email));
      if (adds && next.size > FREE_PEOPLE_LIMIT && limited()) return { refusal: { limit: FREE_PEOPLE_LIMIT } };
      return {
        saved() {
          if (removed.size) endSessions(removed);
          const lists = options.lists();
          keep((was) => [...was, ...added].filter((email) => !removed.has(email) && (options.partialLists || allowedScopes(email, lists))));
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
      keep((was) => was.filter((entry) => entry !== person));
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
      const people = peopleHolding(lists, sessions, kept(lists));
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

/** The server's rule for whether it decides who comes in: not on a Cloud home or Team Cloud, not on a hosted workspace.
 * Any other SEIRA_CLOUD_ROLE leaves the limit on: the server refuses to start with it. */
export function peopleLimitApplies(env: NodeJS.ProcessEnv = process.env): boolean {
  return !hostedWorkspaceConfigured(env) && env.SEIRA_CLOUD_ROLE !== "home" && env.SEIRA_CLOUD_ROLE !== "team";
}

/** For `seira access add`, which edits config.json beside a running server or without one: why the new lists would pass
 * the free limit, else the step to run once config.json is saved (it gives each added address its place, once the server
 * has started on this version). `before` and `after` are config.json's lists; a list the environment names stays in force. */
export async function accessChange(dataDir: string, before: SignInAllowList, after: SignInAllowList, env: NodeJS.ProcessEnv = process.env): Promise<string | { saved(): void }> {
  const pinned = signInFromEnv(env);
  const inForce = (lists: SignInAllowList): SignInAllowList => ({ admins: pinned.admins ?? lists.admins, members: pinned.members ?? lists.members });
  await loadEnterpriseLayer({ env });
  let lists = inForce(before);
  const people = createPeopleLimit({
    dataDir, env, lists: () => lists, sessions: () => sessionsFromFile(dataDir), revoke() {}, partialLists: true,
    applies: peopleLimitApplies(env), enterpriseUnlimited: () => entitled("people-unlimited"),
  });
  const change = people.listsChanging(inForce(after));
  if ("refusal" in change) return `this server's free plan includes ${change.refusal.limit} people; add a Premium key in Settings → People (or set ${TEAM_KEY_ENV}) to add more`;
  return { saved() { lists = inForce(after); change.saved(); } };
}
