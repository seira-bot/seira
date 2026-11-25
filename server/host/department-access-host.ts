// What a member of a self-hosted server sees (department-access.ts): the departments and bots behind a sign-in entry,
// the walls that keep their bots from reaching out of it, and the refusals that follow.
import { entryMatches } from "../../shared/bot-access.ts";
import type { AccessGrant, DepartmentAccessView, GrantLevel } from "../../shared/department-access.ts";
import type { BotVisibility } from "../../shared/wire.ts";
import { botChangeRows, type AdminActionRow } from "../admin-activity.ts";
import { audienceWithin, MAX_VISIBILITY_PEOPLE, storedVisibility, viewerSees, type ResolvedGrant, type VisibleSet } from "../bot-visibility.ts";
import { accessEntry, MAX_GRANTED_BOTS, MAX_GRANTED_DEPARTMENTS, type DepartmentAccess, type StoredGrant } from "../department-access.ts";
import type { WallKind } from "../peer-roster.ts";
import type { RequestAuth } from "../request-auth.ts";

export interface DepartmentAccessHostDeps {
  access: DepartmentAccess;
  /** The departments' current names, General left out. */
  sections(): readonly string[];
  /** A department's stable id; throws when the department file cannot be read. */
  keyOf(name: string): string;
  ensureKey(name: string): string;
  /** A Team Cloud or a hosted workspace: people are managed elsewhere and no grant applies. */
  elsewhere(): boolean;
  visible(auth: RequestAuth): VisibleSet;
  forgetVisibility(): void;
  closeStreams(matches: (email: string) => boolean): void;
  /** Every bot of the server, with its department and who may see it. */
  bots(): readonly { id: string; name?: string; section?: string; visibility?: unknown }[];
  /** Sets a bot's audience the way an admin's change does: saved, announced, and applied to every open stream. */
  setAudience(botId: string, visibility: BotVisibility): void;
  /** Writes admin activity rows for the change that is running. */
  record(rows: Array<Omit<AdminActionRow, "at" | "actor">>): void;
}

export type DepartmentAccessResult = { ok: true } | { ok: false; status: number; error: string };

type Wallable = { id: string; section?: string; visibility?: unknown };

const NOT_AVAILABLE = "This is not available with limited access.";
const BLOCKED_PATHS = /^\/api\/(?:team-files(?:\/|$)|workspace-backup\/restore$)/;
const CHOOSE = "Choose at least one department or bot.";
const WHOLE_TEAM = "whole team";
const sectionKey = (section?: string): string => section?.trim() || "";
const refuse = (error: string): DepartmentAccessResult => ({ ok: false, status: 400, error });
const isLevel = (value: unknown): value is GrantLevel => value === "view" || value === "chat";
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function createDepartmentAccessHost(deps: DepartmentAccessHostDeps) {
  let walls: ReadonlySet<string> | null = null;
  let resolvedGrants: ReadonlyArray<{ entry: string; named: boolean; grant: ResolvedGrant }> | null = null;

  /** The current department names behind a stored grant's ids, with their levels. An id with no department left names nothing. */
  function resolve(grant: StoredGrant): ResolvedGrant {
    const levels = new Map(grant.departments.map((one) => [one.id, one.level]));
    const departments = new Map<string, GrantLevel>();
    const general = levels.get("");
    if (general) departments.set("", general);
    for (const name of deps.sections()) {
      const level = levels.get(deps.keyOf(name));
      if (level) departments.set(name, level);
    }
    return { departments, bots: new Map(grant.bots.map((one) => [one.id, one.level])) };
  }

  const nothing = (): ResolvedGrant => ({ departments: new Map(), bots: new Map() });

  function grantFor(email: string | undefined): ResolvedGrant | null {
    if (deps.elsewhere()) return null;
    if (deps.access.unreadable) return nothing();
    const stored = deps.access.forPerson(email);
    if (!stored) return null;
    try {
      return resolve(stored);
    } catch {
      return nothing();
    }
  }

  /** A department that any grant names. Its bots reach only bots of their own department. */
  function walled(section: string): boolean {
    if (deps.elsewhere()) return false;
    if (deps.access.unreadable) return true;
    if (!walls) {
      try {
        walls = new Set(Object.values(deps.access.all()).flatMap((grant) => [...resolve(grant).departments.keys()]));
      } catch {
        return true;
      }
    }
    return walls.has(section.trim());
  }

  const names = (grant: ResolvedGrant, bot: Wallable): boolean => grant.departments.has(sectionKey(bot.section)) || grant.bots.has(bot.id);

  /** Whether at least one person under the entry may see the bot: an `@domain` entry counts each address of it. */
  function someoneSees(entry: string, grant: ResolvedGrant, bot: Wallable): boolean {
    if (!names(grant, bot)) return false;
    const stored = storedVisibility(bot.visibility);
    if (stored === "everyone") return true;
    if (stored === "admins") return false;
    return stored.people.some((person) => person === entry || entryMatches(person, entry) || entryMatches(entry, person));
  }

  /** Whether every person under the entry sees the bot. */
  function everyoneSees(entry: string, grant: ResolvedGrant, bot: Wallable): boolean {
    return names(grant, bot) && audienceWithin({ people: [entry] }, bot.visibility);
  }

  /** Security invariant: a bot that anyone with a bot grant may see reaches only bots that every person under that grant
   * sees too, so its words and results never carry to a bot one of them cannot read. Grants with no bot keep the
   * department wall alone. */
  function grantWalled(from: Wallable, target: Wallable): boolean {
    if (deps.elsewhere()) return false;
    if (deps.access.unreadable) return true;
    if (!resolvedGrants) {
      try {
        resolvedGrants = Object.entries(deps.access.all()).map(([entry, grant]) => ({ entry, named: grant.bots.length > 0, grant: resolve(grant) }));
      } catch {
        return true;
      }
    }
    return resolvedGrants.some((one) => one.named && someoneSees(one.entry, one.grant, from) && !everyoneSees(one.entry, one.grant, target));
  }

  /** Why a hand-off from one bot to another is walled, if it is (peer-roster.ts). Unreadable grants wall everything. */
  function wallBetween(from: Wallable, target: Wallable): WallKind | null {
    if (sectionKey(from.section) !== sectionKey(target.section) && walled(sectionKey(from.section))) return "department";
    return grantWalled(from, target) ? "grant" : null;
  }

  function changed(): void {
    walls = null;
    resolvedGrants = null;
    deps.forgetVisibility();
  }

  /** A department was renamed or deleted: grants follow the id, and a deleted department leaves every grant. */
  function departmentsChanged(): void {
    try {
      const live = new Set(["", ...deps.sections().map(deps.keyOf)]);
      deps.access.keepOnly((id) => live.has(id));
    } catch {
      // The department file cannot be read: keep the grants as they are, which only narrows access.
    }
    changed();
    deps.closeStreams((email) => deps.access.forPerson(email) !== null);
  }

  /** A bot was deleted: it leaves every grant, and the people whose grant named it read the change at once. */
  function botDeleted(botId: string): void {
    const affected = Object.entries(deps.access.all()).filter(([, grant]) => grant.bots.some((one) => one.id === botId)).map(([entry]) => entry);
    if (!deps.access.dropBot(botId)) return;
    changed();
    deps.closeStreams((email) => affected.some((entry) => entryMatches(entry, email)));
  }

  function grantView(stored: StoredGrant): AccessGrant {
    let departments: AccessGrant["departments"] = [];
    try {
      departments = [...resolve(stored).departments].map(([name, level]) => ({ name, level }));
    } catch {
      // The department file cannot be read: the grant lists no department, which only narrows access.
    }
    return { departments, bots: stored.bots.map((one) => ({ id: one.id, level: one.level })) };
  }

  function view(): DepartmentAccessView {
    const people: Record<string, AccessGrant> = {};
    if (!deps.elsewhere() && !deps.access.unreadable) {
      for (const [entry, stored] of Object.entries(deps.access.all())) people[entry] = grantView(stored);
    }
    return { available: !deps.elsewhere(), people, unreadable: deps.access.unreadable };
  }

  /** The body's grant, where the older `{ departments: [names] }` shape means level "chat". `null` removes the limit;
   * a string says why the body is refused. */
  function parseBody(record: Record<string, unknown>): AccessGrant | null | string {
    const key = "access" in record ? "access" : "departments" in record ? "departments" : null;
    if (key === null) return CHOOSE;
    const raw = record[key];
    if (raw === null) return null;
    const grant = key === "access" ? raw : { departments: Array.isArray(raw) ? raw.map((name) => ({ name, level: "chat" })) : raw, bots: [] };
    if (!isObject(grant)) return CHOOSE;
    const { departments = [], bots = [] } = grant;
    if (!Array.isArray(departments) || !Array.isArray(bots)) return CHOOSE;
    const items = [...departments, ...bots];
    if (items.some((one) => !isObject(one))) return CHOOSE;
    if (items.some((one) => !isLevel((one as { level?: unknown }).level))) return "Choose view or chat for each item.";
    if (departments.some((one) => typeof (one as { name?: unknown }).name !== "string") || bots.some((one) => typeof (one as { id?: unknown }).id !== "string")) return CHOOSE;
    return { departments: departments as AccessGrant["departments"], bots: bots as AccessGrant["bots"] };
  }

  /** The audience a bot needs so this entry can see it; null when it already does, "full" when it cannot take one more. */
  function admission(entry: string, bot: { visibility?: unknown }): BotVisibility | null | "full" {
    if (audienceWithin({ people: [entry] }, bot.visibility)) return null;
    const own = storedVisibility(bot.visibility);
    const people = typeof own === "string" ? [] : own.people;
    return people.length >= MAX_VISIBILITY_PEOPLE ? "full" : { people: [...people, entry] };
  }

  /** The audience a bot has without this entry, or null when the entry is not exactly one of its people. */
  function withoutEntry(entry: string, bot: { visibility?: unknown }): BotVisibility | null {
    const own = storedVisibility(bot.visibility);
    if (typeof own === "string" || !own.people.includes(entry)) return null;
    const people = own.people.filter((person) => person !== entry);
    return people.length ? { people } : "admins";
  }

  function change(body: unknown): DepartmentAccessResult {
    if (deps.elsewhere()) return { ok: false, status: 409, error: NOT_AVAILABLE };
    const record = isObject(body) ? body : {};
    const entry = accessEntry(record.entry);
    if (!entry) return refuse("Enter an email address or @domain.");
    const access = parseBody(record);
    if (typeof access === "string") return refuse(access);
    const live = new Map(deps.bots().map((bot) => [bot.id, { ...bot }]));
    const audience: Array<{ id: string; visibility: BotVisibility }> = [];
    let previous: StoredGrant | undefined;
    let stored: StoredGrant | null = null;
    try {
      previous = deps.access.all()[entry];
      const kept = new Set(access ? access.bots.map((one) => one.id) : []);
      const admitted = new Set((previous?.admitted ?? []).filter((id) => kept.has(id)));
      if (access) {
        const names = new Set(access.departments.map((one) => one.name));
        if (names.size === 0 && kept.size === 0) return refuse(CHOOSE);
        if (names.size > MAX_GRANTED_DEPARTMENTS) return refuse("Choose fewer departments.");
        if (kept.size > MAX_GRANTED_BOTS) return refuse("Choose fewer bots.");
        const known = new Set(deps.sections());
        if ([...names].some((name) => name !== "" && !known.has(name))) return refuse("No such department.");
        if ([...kept].some((id) => !live.has(id))) return refuse("No such bot.");
        const joins: Array<{ id: string; visibility: BotVisibility }> = [];
        for (const id of kept) {
          const next = admission(entry, live.get(id)!);
          if (next === "full") return refuse("That bot is shared with too many people already.");
          if (next) joins.push({ id, visibility: next });
        }
        if (joins.length) {
          const list = joins.map((one) => live.get(one.id)?.name ?? one.id).join(", ");
          if (entry.startsWith("@")) return refuse(`To give access to ${list}, invite each person by their own address.`);
          if (record.admitBots !== true) return refuse(`Inviting adds this person to the people who can use ${list}. Confirm to continue.`);
        }
        for (const one of joins) admitted.add(one.id);
        audience.push(...joins);
        stored = {
          departments: access.departments.map((one) => ({ id: one.name === "" ? "" : deps.ensureKey(one.name), level: one.level })),
          bots: access.bots.map((one) => ({ id: one.id, level: one.level })),
          ...(admitted.size ? { admitted: [...admitted] } : {}),
        };
      }
      for (const id of previous?.admitted ?? []) {
        const bot = live.get(id);
        const next = !kept.has(id) && bot ? withoutEntry(entry, bot) : null;
        if (next) audience.push({ id, visibility: next });
      }
      deps.access.set(entry, stored);
    } catch {
      return { ok: false, status: 409, error: "Department access cannot be changed right now." };
    }
    const rows: Array<Omit<AdminActionRow, "at" | "actor">> = [];
    for (const one of audience) {
      const bot = live.get(one.id)!;
      deps.setAudience(one.id, one.visibility);
      rows.push(...botChangeRows({ id: one.id, name: bot.name }, { visibility: bot.visibility }, { visibility: one.visibility }, ["visibility"]));
    }
    rows.push({
      category: "people", action: "people.update", target: { kind: "person", name: entry }, changed: ["access"],
      before: { access: previous ? grantView(previous) : WHOLE_TEAM }, after: { access: stored ? grantView(stored) : WHOLE_TEAM },
    });
    changed();
    deps.closeStreams((email) => entryMatches(entry, email));
    try {
      deps.record(rows);
    } catch {
      // The change is saved; a failed log write must not undo it.
    }
    return { ok: true };
  }

  /** Why a member limited to some departments or bots may not make this request, else null. */
  function refuses(auth: RequestAuth, path: string): string | null {
    if (auth.kind !== "session" || !BLOCKED_PATHS.test(path)) return null;
    return deps.visible(auth).limitedToDepartments ? NOT_AVAILABLE : null;
  }

  function sectionRefusal(auth: RequestAuth, section: unknown): string | null {
    return deps.visible(auth).departmentAllowed(section) ? null : "You do not have access to that department.";
  }

  const chatsWith = (grant: ResolvedGrant, bot: Wallable): boolean =>
    grant.bots.get(bot.id) === "chat" || grant.departments.get(sectionKey(bot.section)) === "chat";

  /** Whether every grant lets its people chat with the bot, and its audience admits them all: what a relay that names
   * nobody needs, since it may be any of them. */
  function everyGrantChats(bot: Wallable): boolean {
    if (deps.elsewhere()) return true;
    if (deps.access.unreadable) return false;
    try {
      return Object.entries(deps.access.all()).every(([entry, stored]) => chatsWith(resolve(stored), bot) && audienceWithin({ people: [entry] }, bot.visibility));
    } catch {
      return false;
    }
  }

  /** Security: a message that another app relays for a person whose access is limited needs what Seira itself needs from
   * that person: the bot in their access at "chat", and an audience that admits them. One that names nobody may be any
   * limited person, so it needs every grant to allow chat. Admins and people without limits pass. */
  function relayRefusal(bot: Wallable & { name: string }, email: string | undefined, admin: boolean): string | null {
    if (admin) return null;
    if (!email) return everyGrantChats(bot) ? null : `Someone outside the people added can't chat with ${bot.name} here.`;
    const grant = grantFor(email);
    if (!grant) return null;
    return chatsWith(grant, bot) && viewerSees({ kind: "member", email }, bot.visibility) ? null : `${email} can't chat with ${bot.name} here.`;
  }

  return { grantFor, walled, wallBetween, view, change, refuses, sectionRefusal, relayRefusal, departmentsChanged, botDeleted, changed };
}

export type DepartmentAccessHost = ReturnType<typeof createDepartmentAccessHost>;
