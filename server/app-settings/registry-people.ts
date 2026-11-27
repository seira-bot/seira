// Who may sign in to a self-hosted server: a bot invites a person, changes what they see, or removes them. Each change
// waits for the admin's Apply, then goes through the same two routes Settings uses (the sign-in lists and the access
// a person gets), so their checks still run. Nothing here returns an address list or a link that signs anyone in.
import { z } from "zod";

import type { AccessGrant } from "../../shared/department-access.ts";
import { allowedScopes } from "../account-signin.ts";
import { accessEntry } from "../department-access.ts";
import type { Consequence } from "./confirm.ts";
import { placePath } from "./places.ts";
import { withoutKeys, type RegistryDeps, type SettingEntry, type WritableSpec } from "./registry.ts";

/** What the people entry needs to know of this place. */
export interface PeopleDeps {
  /** "desktop": the app's own computer. "team": a Team Cloud or a hosted workspace. "cloud-home": a personal Cloud. */
  place(): "desktop" | "team" | "cloud-home" | "server";
  emailSignIn(): boolean;
  publicUrl(): string | null;
  grants(): Record<string, AccessGrant>;
}

type Role = "user" | "admin" | "none";
type Level = "view" | "chat";
/** A department or bot by name (a bot also by id), with the level it keeps when none is given: chat for a new one. */
type Item = string | { name: string; level: Level };
type Sees = "whole team" | { departments?: Item[]; bots?: Item[] };
/** Addresses at an @domain with a list entry of their own, by role, and users with access of their own: the role rule and
 * the access rule are apart, and an admin sees everything whatever a grant says. */
type Under = { admins: number; users: number; withAccess: number };
/** `effective`: only on the value `current` gives (Undo writes it back), never on a bot's: the schema refuses the field. */
type Person = { email: string; role?: Role; sees?: Sees; effective?: { role: Role; sees: Sees; under?: Under } };
/** What a person holds once the names are resolved; a department's name is "" for General. */
interface Held { departments: Array<{ name: string; level: Level }>; bots: Array<{ id: string; name: string; level: Level }> }

const WHOLE_TEAM = "whole team";
const GENERAL = "General";
const REFUSALS = {
  desktop: "This computer has no list of people to sign in. Start a Team on Seira Cloud, or run your own server and connect to it.",
  team: "People of a Team are invited by a Team admin, from the Team's own People page. A bot cannot invite them.",
  "cloud-home": "My Cloud belongs to one person, so it has nobody to invite. Start a Team to work with others.",
  noEmail: "Nobody can sign in by email on this server, so an invite would not reach anyone. Set up email sign-in first.",
  none: "This place has no list of people.",
} as const;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** The @domain an address falls under; none for an @domain entry itself. */
const domainOf = (entry: string): string | null => (entry.startsWith("@") ? null : entry.slice(entry.lastIndexOf("@")));
const names = (list: readonly string[]) => list.join(", ");

const item = z.union([z.string().trim().min(1).max(120), z.object({ name: z.string().trim().min(1).max(120), level: z.enum(["view", "chat"]) }).strict()]);

export function peopleEntries(deps: Pick<RegistryDeps, "cfg" | "bots" | "sections" | "saveConfig" | "call" | "people">, writable: (spec: WritableSpec) => SettingEntry): SettingEntry[] {
  const lists = () => ({ admins: [...(deps.cfg().signIn?.admins ?? [])], members: [...(deps.cfg().signIn?.members ?? [])] });
  const roleOf = (entry: string): Role => {
    const { admins, members } = lists();
    return admins.some((one) => same(one, entry)) ? "admin" : members.some((one) => same(one, entry)) ? "user" : "none";
  };
  const grantOf = (entry: string): AccessGrant | undefined => deps.people?.grants()[entry];
  const asSees = (grant: AccessGrant | undefined): Sees =>
    grant ? { departments: grant.departments.map((one) => ({ name: one.name || GENERAL, level: one.level })), bots: grant.bots.map((one) => ({ name: one.id, level: one.level })) } : WHOLE_TEAM;
  const seesNow = (entry: string): Sees => asSees(grantOf(entry));
  // Security invariant: what a card promises follows the rules the server enforces, not the entry alone. Sign-in admits an
  // address by its own entry or its @domain, and an admin entry wins (account-signin allowedScopes); access is the address's
  // own grant, else its @domain's (DepartmentAccess.forPerson).
  const signsInAs = (address: string, list: { admins: string[]; members: string[] } = lists()): Role => {
    const scopes = allowedScopes(address, list);
    return scopes?.includes("admin") ? "admin" : scopes ? "user" : "none";
  };
  const domainGrant = (entry: string): AccessGrant | undefined => {
    const domain = domainOf(entry);
    return domain ? grantOf(domain) : undefined;
  };
  /** The access the server gives this entry now: its own grant, else its @domain's; none means the whole team. */
  const effectiveGrant = (entry: string): AccessGrant | undefined => grantOf(entry) ?? domainGrant(entry);
  /** A grant with nothing left in it (what it named was deleted) shows nothing, never the whole team. */
  const isEmpty = (grant: AccessGrant) => !grant.departments.length && !grant.bots.length;
  const heldOf = (grant: AccessGrant): Held => ({
    departments: grant.departments.map((one) => ({ name: one.name, level: one.level })),
    bots: grant.bots.map((one) => ({ id: one.id, name: deps.bots().find((bot) => bot.id === one.id)?.name ?? one.id, level: one.level })),
  });
  /** The sign-in lists once `entry` has `role`. */
  const listsWith = (entry: string, role: Role) => {
    const rest = (list: string[]) => list.filter((one) => !same(one, entry));
    const { admins, members } = lists();
    return { admins: [...rest(admins), ...(role === "admin" ? [entry] : [])], members: [...rest(members), ...(role === "user" ? [entry] : [])] };
  };
  /** Addresses at an @domain that have a list entry or access of their own: the domain's rule does not decide for them. An
   * address on both lists signs in as an admin, and an admin's grant changes nothing, so neither counts as a user. */
  const listedUnder = (domain: string): Under => {
    const under = (one: string) => !one.startsWith("@") && one.trim().toLowerCase().endsWith(domain);
    const { admins, members } = lists();
    const ownAdmins = admins.filter(under);
    const user = (one: string) => under(one) && !ownAdmins.some((admin) => same(admin, one));
    return { admins: ownAdmins.length, users: members.filter(user).length, withAccess: Object.keys(deps.people?.grants() ?? {}).filter(user).length };
  };
  const place = () => deps.people?.place() ?? "none";
  const unavailable = (): string | null => {
    const where = place();
    if (where !== "server") return REFUSALS[where];
    return deps.people?.emailSignIn() ? null : REFUSALS.noEmail;
  };

  /** The departments and bots a `sees` names, by the names or ids the bot gave; a string says what does not exist. An item with
   * no level keeps the one the person has now, from their own grant or their @domain's, so a name alone never widens it. */
  const resolve = (sees: Sees, entry: string): Held | string => {
    if (sees === WHOLE_TEAM) return { departments: [], bots: [] };
    const grant = effectiveGrant(entry);
    const known = deps.sections();
    const held: Held = { departments: [], bots: [] };
    for (const item of sees.departments ?? []) {
      const asked = typeof item === "string" ? item : item.name;
      const found = same(asked, GENERAL) ? "" : known.find((one) => same(one, asked));
      if (found === undefined) return `No department is named ${asked}. The departments are: ${names([GENERAL, ...known])}.`;
      if (held.departments.some((one) => one.name === found)) continue;
      held.departments.push({ name: found, level: typeof item === "string" ? grant?.departments.find((one) => one.name === found)?.level ?? "chat" : item.level });
    }
    for (const item of sees.bots ?? []) {
      const asked = typeof item === "string" ? item : item.name;
      const found = deps.bots().find((one) => one.id === asked) ?? deps.bots().find((one) => same(one.name, asked));
      if (!found) return `No bot is named ${asked}. Use list_bots for the names.`;
      if (held.bots.some((one) => one.id === found.id)) continue;
      held.bots.push({ id: found.id, name: found.name, level: typeof item === "string" ? grant?.bots.find((one) => one.id === found.id)?.level ?? "chat" : item.level });
    }
    return held.departments.length || held.bots.length ? held : "Choose at least one department or bot, or give the whole team.";
  };
  /** `shown`: the access the person ends with; null is the whole team, an empty one is nothing. */
  interface Made { entry: string; before: Role; role: Role; access: "keep" | Held | null; shown: Held | null }
  const empty = (held: Held) => !held.departments.length && !held.bots.length;

  /** What the change makes true, or why it cannot be made. `access` is "keep" when the request names no access. */
  const plan = (value: Person): { refusal: string } | Made => {
    const blocked = unavailable();
    if (blocked) return { refusal: blocked };
    const entry = accessEntry(value.email);
    if (!entry) return { refusal: "Enter an email address or @domain." };
    const before = roleOf(entry);
    const role = value.role ?? (before === "none" ? "user" : before);
    const restoring = value.effective !== undefined;
    // Undo of a person whose grant had nothing left: the access route cannot store an empty grant, so only an unchanged one
    // can be kept; anything else would give them more than they had.
    const nothing = typeof value.sees === "object" && !value.sees.departments?.length && !value.sees.bots?.length;
    const own = grantOf(entry);
    if (restoring && nothing && role !== "none" && !(own && isEmpty(own))) {
      return { refusal: `${entry} saw nothing before this change, so Undo cannot set that back. Choose what ${entry} sees in ${placePath("members")}.` };
    }
    const sees = restoring && nothing ? undefined : value.sees;
    const asked = role === "none" || sees === undefined ? null : resolve(sees, entry);
    if (typeof asked === "string") return { refusal: asked };
    if (entry.startsWith("@") && role === "admin") return { refusal: `A bot cannot make a whole @domain an admin. The person does that in ${placePath("members")}.` };
    if (entry.startsWith("@") && asked?.bots.length) return { refusal: "To give access to chosen bots, invite each person by their own address." };
    const domain = domainOf(entry);
    if (role === "none" && before === "none") {
      return { refusal: domain && signsInAs(entry) !== "none"
        ? `${entry} is not on the list on their own: everyone at ${domain} may sign in. Remove ${domain} to stop that.`
        : `${entry} is not on the list.` };
    }
    if (before === "admin" && role !== "admin" && lists().admins.length <= 1) return { refusal: "This is the only admin. The server needs one admin, so make someone else an admin first." };
    const access: "keep" | Held | null = role === "none" ? null : asked === null ? "keep" : empty(asked) ? null : asked;
    // What the card names: the access the person ends with, their @domain's when they keep none of their own.
    const kept = effectiveGrant(entry);
    const shown = access === "keep" ? (kept ? heldOf(kept) : null) : access;
    // Undo writes back the entries as they were, so only a new change has to give what its card says.
    if (!restoring) {
      if (role === "user" && shown && empty(shown)) return { refusal: `${entry} would see nothing. Name what ${entry} should see, or give the whole team.` };
      const after = domain ? signsInAs(entry, listsWith(entry, role)) : role;
      if (role === "none" && after !== "none") return { refusal: `${entry} would still sign in, because everyone at ${domain} may sign in. Remove ${domain} first.` };
      if (role === "user" && after === "admin") return { refusal: `${entry} would still sign in as an admin, because everyone at ${domain} is an admin. Change ${domain} first.` };
      if (role === "user" && access === null && domainGrant(entry)) {
        return { refusal: `${entry} would see only what everyone at ${domain} sees, not the whole team. Name what ${entry} should see, or change ${domain} first.` };
      }
      const listed = domain ? null : listedUnder(entry);
      if (listed && role === "none" && listed.admins + listed.users) {
        return { refusal: `Some addresses at ${entry} are on the list on their own and would still sign in. Remove them first, or remove ${entry} in ${placePath("members")}.` };
      }
    }
    const sameSet = <T>(a: T[], b: T[], key: (one: T) => string) => a.length === b.length && a.every((one) => b.some((other) => key(other) === key(one)));
    const sameAccess = asked !== null && (empty(asked) ? !own : Boolean(own)
      && sameSet(asked.departments, own!.departments, (one) => `${one.name}:${one.level}`) && sameSet(asked.bots, own!.bots, (one) => `${one.id}:${one.level}`));
    if (role === before && (asked === null || sameAccess)) return { refusal: `${entry} already has this.` };
    return { entry, before, role, access, shown };
  };
  /** Sign-in and access follow two rules: an own list entry decides the role, an own grant decides what a user sees. A bot never
   * leaves an @domain an admin, so the domain's card is a user's: its access binds only the users at the domain with no grant of
   * their own, never an admin, who sees everything. */
  const apart = (domain: string): string => {
    const { admins, users, withAccess } = listedUnder(domain);
    const count = (n: number, one: string, many: string) => (!n ? "" : n === 1 ? ` 1 address at ${domain} ${one}.` : ` ${n} addresses at ${domain} ${many}.`);
    const others = admins && withAccess ? " who is not an admin and has no access of their own" : admins ? " who is not an admin" : withAccess ? " with no access of their own" : "";
    return count(admins, "is an admin on its own and sees everything", "are admins on their own and see everything")
      + count(users, "is on the list on its own as a user", "are on the list on their own as users")
      + count(withAccess, "has access of its own and keeps it", "have access of their own and keep it")
      + (admins || users || withAccess ? ` Everyone at ${domain}${others} sees what is named above.` : "");
  };
  const scopeWords = (held: Held | null): string =>
    held ? names([...held.departments.map((one) => `${one.name || GENERAL}${one.level === "view" ? " (view only)" : ""}`), ...held.bots.map((one) => `${one.name}${one.level === "view" ? " (view only)" : ""}`)]) : "";

  return [
    writable({
      id: "people.signIn", label: "People who sign in", where: "members",
      help: "Who may sign in to this server: invite a person by email or @domain, change what they see, make them an admin, or remove them. Only on a self-hosted server with email sign-in.",
      synonyms: ["people", "members", "invite", "invitation", "roles", "admins", "sign in access", "add a person", "remove a person", "team"],
      value: withoutKeys(z.object({
        email: z.string().trim().min(1).max(320),
        role: z.enum(["user", "admin", "none"]).optional(),
        sees: z.union([z.literal(WHOLE_TEAM), z.object({ departments: z.array(item).max(200).optional(), bots: z.array(item).max(200).optional() }).strict()]).optional(),
      }).strict()),
      allowed: `{"email": an address or @domain, "role"?: "user" | "admin" | "none" (none removes the person), "sees"?: "${WHOLE_TEAM}" | {"departments"?: [name or {"name","level"}], "bots"?: [name or {"name","level"}]}} with level "view" or "chat" (a name alone keeps the level the person has now, also one from their @domain, or chat for a new item). A new person is a user who sees the whole team, or what their @domain sees; a person already on the list keeps their role and access unless you name them`,
      read: () => {
        const blocked = unavailable();
        if (blocked) return blocked;
        const { admins, members } = lists();
        return `${admins.length} admin${admins.length === 1 ? "" : "s"}, ${members.length} other ${members.length === 1 ? "entry" : "entries"}; the Settings window lists them`;
      },
      more: () => ({ roles: ["user", "admin", "none"] }),
      describe: (value: Person) => {
        const made = plan(value);
        if ("refusal" in made) return made;
        const { entry, before, role } = made;
        if (role === "none") return { change: `Remove ${entry}; they can no longer sign in` };
        const link = before === "none" && deps.people?.publicUrl() ? ` They sign in at ${deps.people.publicUrl()}.` : "";
        // An admin sees everything whatever their grant says, so only a user's card names what they see.
        const scope = role === "admin" ? "" : made.shown === null ? ", sees the whole team" : empty(made.shown) ? ", sees nothing" : `, sees only ${scopeWords(made.shown)}`;
        return { change: `${before === "none" ? "Invite" : "Change"} ${entry} as ${role}${scope}.${link}${entry.startsWith("@") ? apart(entry) : ""}` };
      },
      current: (value: Person) => {
        const entry = accessEntry(value.email);
        if (!entry) return undefined;
        // The domain card's note counts the addresses under it by role, so a new entry, a role change or a new grant under it
        // makes its Apply stale too.
        const effective = entry.startsWith("@")
          ? { role: roleOf(entry), sees: seesNow(entry), under: listedUnder(entry) }
          : { role: signsInAs(entry), sees: asSees(effectiveGrant(entry)) };
        return { email: entry, role: roleOf(entry), sees: seesNow(entry), effective } satisfies Person;
      },
      confirm: (value: Person): Consequence | null => {
        const made = plan(value);
        if ("refusal" in made) return null;
        const params = { who: made.entry };
        if (made.role === "none") return { code: "personOut", params };
        if (made.role === "admin") return { code: "adminIn", params };
        if (made.shown && empty(made.shown)) return null;
        const sees = scopeWords(made.shown);
        if (made.entry.startsWith("@")) return { code: "domainIn", params };
        return sees ? { code: "chosenIn", params: { ...params, sees } } : { code: "wholeIn", params };
      },
      write: async (value: Person) => {
        const made = plan(value);
        if ("refusal" in made) return made.refusal;
        const { entry, before, role } = made;
        const old = lists();
        const was = grantOf(entry);
        const { access } = made;
        const saveLists = async (): Promise<string | null> => {
          if (role === before) return null;
          const rest = (list: string[]) => list.filter((one) => !same(one, entry));
          const next = { admins: rest(old.admins), members: rest(old.members) };
          if (role === "admin") next.admins.push(entry);
          if (role === "user") next.members.push(entry);
          return deps.saveConfig({ signIn: next });
        };
        const putAccess = async (access: Array<{ name: string; level: string }> | null, bots: Array<{ id: string; level: string }>): Promise<string | null> =>
          deps.call("departmentAccess", "PUT", "/api/department-access", { entry, admitBots: true, access: access ? { departments: access, bots } : null });
        const saveAccess = async (): Promise<string | null> => {
          if (access === "keep" || (access === null && !was)) return null;
          return putAccess(access && access.departments.map((one) => ({ name: one.name, level: one.level })), access ? access.bots.map((one) => ({ id: one.id, level: one.level })) : []);
        };
        const restoreAccess = () => (was ? putAccess(was.departments.map((one) => ({ name: one.name, level: one.level })), was.bots.map((one) => ({ id: one.id, level: one.level }))) : putAccess(null, []));
        // A person who stays a user gets their limits before the list can let them in; anyone else leaves or gains power only
        // after the list changes, so no one holds a wider view in between.
        if (role === "user") {
          const refused = await saveAccess();
          if (refused) return refused;
          const listed = await saveLists();
          if (listed && access !== "keep" && (access || was)) await restoreAccess();
          return listed;
        }
        const listed = await saveLists();
        if (listed) return listed;
        const refused = await saveAccess();
        if (refused && role !== before) await deps.saveConfig({ signIn: old });
        return refused;
      },
    }),
  ];
}
