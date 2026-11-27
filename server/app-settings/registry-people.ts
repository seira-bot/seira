// Who may sign in to a self-hosted server: a bot invites a person, changes what they see, or removes them. Each change
// waits for the admin's Apply, then goes through the same two routes Settings uses (the sign-in lists and the access
// a person gets), so their checks still run. Nothing here returns an address list or a link that signs anyone in.
import { z } from "zod";

import type { AccessGrant } from "../../shared/department-access.ts";
import { accessEntry } from "../department-access.ts";
import type { Consequence } from "./confirm.ts";
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
type Sees = "whole team" | { departments?: string[]; bots?: string[] };
type Person = { email: string; role?: Role; sees?: Sees };

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
const names = (list: readonly string[]) => list.join(", ");

export function peopleEntries(deps: Pick<RegistryDeps, "cfg" | "bots" | "sections" | "saveConfig" | "call" | "people">, writable: (spec: WritableSpec) => SettingEntry): SettingEntry[] {
  const lists = () => ({ admins: [...(deps.cfg().signIn?.admins ?? [])], members: [...(deps.cfg().signIn?.members ?? [])] });
  const roleOf = (entry: string): Role => {
    const { admins, members } = lists();
    return admins.some((one) => same(one, entry)) ? "admin" : members.some((one) => same(one, entry)) ? "user" : "none";
  };
  const grantOf = (entry: string): AccessGrant | undefined => deps.people?.grants()[entry];
  const seesNow = (entry: string): Sees => {
    const grant = grantOf(entry);
    return grant ? { departments: grant.departments.map((one) => one.name || GENERAL), bots: grant.bots.map((one) => one.id) } : WHOLE_TEAM;
  };
  const place = () => deps.people?.place() ?? "none";
  const unavailable = (): string | null => {
    const where = place();
    if (where !== "server") return REFUSALS[where];
    return deps.people?.emailSignIn() ? null : REFUSALS.noEmail;
  };

  /** The departments and bots a `sees` names, by the names or ids the bot gave; a string says what does not exist. */
  const resolve = (sees: Sees): { departments: string[]; bots: Array<{ id: string; name: string }> } | string => {
    if (sees === WHOLE_TEAM) return { departments: [], bots: [] };
    const known = deps.sections();
    const departments: string[] = [];
    for (const asked of sees.departments ?? []) {
      const found = same(asked, GENERAL) ? "" : known.find((one) => same(one, asked));
      if (found === undefined) return `No department is named ${asked}.`;
      if (!departments.includes(found)) departments.push(found);
    }
    const bots: Array<{ id: string; name: string }> = [];
    for (const asked of sees.bots ?? []) {
      const found = deps.bots().find((one) => one.id === asked) ?? deps.bots().find((one) => same(one.name, asked));
      if (!found) return `No bot is named ${asked}. Use list_bots for the names.`;
      if (!bots.some((one) => one.id === found.id)) bots.push({ id: found.id, name: found.name });
    }
    return departments.length || bots.length ? { departments, bots } : "Choose at least one department or bot, or give the whole team.";
  };

  /** What the change makes true, or why it cannot be made. */
  const plan = (value: Person) => {
    const blocked = unavailable();
    if (blocked) return { refusal: blocked };
    const entry = accessEntry(value.email);
    if (!entry) return { refusal: "Enter an email address or @domain." };
    const before = roleOf(entry);
    const role = value.role ?? (before === "none" ? "user" : before);
    const sees = role === "user" ? value.sees ?? seesNow(entry) : WHOLE_TEAM;
    const chosen = resolve(sees);
    if (typeof chosen === "string") return { refusal: chosen };
    if (entry.startsWith("@") && chosen.bots.length) return { refusal: "To give access to chosen bots, invite each person by their own address." };
    if (role === "none" && before === "none") return { refusal: `${entry} is not on the list.` };
    if (before === "admin" && role !== "admin" && lists().admins.length <= 1) return { refusal: "This is the only admin. The server needs one admin, so make someone else an admin first." };
    const grant = grantOf(entry);
    const none = !chosen.departments.length && !chosen.bots.length;
    const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((one) => b.includes(one));
    const sameSees = none ? !grant : Boolean(grant) && sameSet(chosen.departments, grant!.departments.map((one) => one.name)) && sameSet(chosen.bots.map((one) => one.id), grant!.bots.map((one) => one.id));
    if (role === before && (role !== "user" || sameSees)) return { refusal: `${entry} already has this.` };
    return { entry, before, role, sees: role === "user" ? chosen : null };
  };
  const scopeWords = (chosen: { departments: string[]; bots: Array<{ id: string; name: string }> } | null): string =>
    chosen && (chosen.departments.length || chosen.bots.length) ? names([...chosen.departments.map((one) => one || GENERAL), ...chosen.bots.map((one) => one.name)]) : "";

  return [
    writable({
      id: "people.signIn", label: "People who sign in", where: "members",
      help: "Who may sign in to this server: invite a person by email or @domain, change what they see, make them an admin, or remove them. Only on a self-hosted server with email sign-in.",
      synonyms: ["people", "members", "invite", "invitation", "roles", "admins", "sign in access", "add a person", "remove a person", "team"],
      value: withoutKeys(z.object({
        email: z.string().trim().min(1).max(320),
        role: z.enum(["user", "admin", "none"]).optional(),
        sees: z.union([z.literal(WHOLE_TEAM), z.object({ departments: z.array(z.string().trim().min(1).max(120)).max(200).optional(), bots: z.array(z.string().trim().min(1).max(120)).max(200).optional() }).strict()]).optional(),
      }).strict()),
      allowed: `{"email": an address or @domain, "role"?: "user" | "admin" | "none" (none removes the person), "sees"?: "${WHOLE_TEAM}" | {"departments"?: [names], "bots"?: [names]}}. A new person is a user who sees the whole team; a person already on the list keeps their role and access unless you name them`,
      read: () => {
        const blocked = unavailable();
        if (blocked) return blocked;
        const { admins, members } = lists();
        return `${admins.length} admin${admins.length === 1 ? "" : "s"}, ${members.length} other ${members.length === 1 ? "entry" : "entries"}; the Settings window lists them`;
      },
      more: () => ({ roles: ["user", "admin", "none"], departments: [GENERAL, ...deps.sections()], bots: deps.bots().map((one) => one.name) }),
      describe: (value: Person) => {
        const made = plan(value);
        if ("refusal" in made) return made;
        const { entry, before, role } = made;
        if (role === "none") return { change: `Remove ${entry}; they can no longer sign in` };
        const link = before === "none" && deps.people?.publicUrl() ? ` They sign in at ${deps.people.publicUrl()}.` : "";
        const scope = made.sees && scopeWords(made.sees) ? `, sees only ${scopeWords(made.sees)}` : role === "user" ? ", sees the whole team" : "";
        return { change: `${before === "none" ? "Invite" : "Change"} ${entry} as ${role}${scope}.${link}` };
      },
      current: (value: Person) => {
        const entry = accessEntry(value.email);
        return entry ? ({ email: entry, role: roleOf(entry), sees: seesNow(entry) } satisfies Person) : undefined;
      },
      confirm: (value: Person): Consequence | null => {
        const made = plan(value);
        if ("refusal" in made) return null;
        const params = { who: made.entry };
        if (made.role === "none") return { code: "personOut", params };
        if (made.role === "admin") return { code: "adminIn", params };
        const sees = scopeWords(made.sees);
        return sees ? { code: "chosenIn", params: { ...params, sees } } : { code: "wholeIn", params };
      },
      write: async (value: Person) => {
        const made = plan(value);
        if ("refusal" in made) return made.refusal;
        const { entry, before, role } = made;
        const old = lists();
        const was = grantOf(entry);
        const target = made.sees && (made.sees.departments.length || made.sees.bots.length) ? made.sees : null;
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
          if (!target && !was) return null;
          return putAccess(target ? target.departments.map((name) => ({ name, level: "chat" })) : null, target ? target.bots.map((one) => ({ id: one.id, level: "chat" })) : []);
        };
        const restoreAccess = () => (was ? putAccess(was.departments.map((one) => ({ name: one.name, level: one.level })), was.bots.map((one) => ({ id: one.id, level: one.level }))) : putAccess(null, []));
        // A person who stays a user gets their limits before the list can let them in; anyone else leaves or gains power only
        // after the list changes, so no one holds a wider view in between.
        if (role === "user") {
          const refused = await saveAccess();
          if (refused) return refused;
          const listed = await saveLists();
          if (listed && (target || was)) await restoreAccess();
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
