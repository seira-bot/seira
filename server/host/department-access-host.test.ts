import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { AdminActionRow } from "../admin-activity.ts";
import { VisibleSet, type Viewer } from "../bot-visibility.ts";
import type { BotVisibility } from "../../shared/wire.ts";
import { DepartmentAccess } from "../department-access.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createDepartmentAccessHost } from "./department-access-host.ts";

const root = mkdtempSync(join(tmpdir(), "dept-access-host-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;

function fixture(options: { elsewhere?: boolean; content?: string } = {}) {
  const path = join(root, `grants-${counter++}.json`);
  if (options.content !== undefined) writeFileSync(path, options.content);
  const access = new DepartmentAccess(path);
  const state = { sections: ["Sales", "Finance"], keys: { Sales: "team:sales", Finance: "team:fin" } as Record<string, string>, unreadableSections: false };
  const forget = vi.fn();
  const closed: string[][] = [];
  const emails = ["ada@acme.test", "bob@acme.test", "cy@other.test"];
  const bots: Array<{ id: string; name: string; threadId: string; section?: string; visibility?: unknown }> = [{ id: "s", name: "Sam", threadId: "t-s", section: "Sales" }, { id: "f", name: "Fin", threadId: "t-f", section: "Finance" }, { id: "g", name: "Gus", threadId: "t-g" }];
  const rows: Array<Omit<AdminActionRow, "at" | "actor">> = [];
  const admitted: Array<{ id: string; visibility: BotVisibility }> = [];
  const host = createDepartmentAccessHost({
    access,
    sections: () => state.sections,
    keyOf: (name) => { if (state.unreadableSections) throw new Error("unreadable"); return state.keys[name] ?? name; },
    ensureKey: (name) => (state.keys[name] ??= name),
    elsewhere: () => options.elsewhere === true,
    visible: (auth) => new VisibleSet(bots, [], { kind: "member", email: (auth as { session?: { email?: string } }).session?.email } as Viewer, undefined, undefined, host.grantFor((auth as { session?: { email?: string } }).session?.email)),
    forgetVisibility: forget,
    closeStreams: (matches) => closed.push(emails.filter(matches)),
    bots: () => bots,
    record: (written) => { rows.push(...written); },
    setAudience: (id, visibility) => { admitted.push({ id, visibility }); const bot = bots.find((one) => one.id === id); if (bot) bot.visibility = visibility; },
  });
  return { host, access, state, forget, closed, path, bots, admitted, rows };
}
const names = (host: ReturnType<typeof fixture>["host"], email: string | undefined) => { const grant = host.grantFor(email); return grant && [...grant.departments.keys()].sort(); };
const member = (email: string) => ({ kind: "session", scopes: ["client"], session: { email } }) as unknown as RequestAuth;

describe("who sees which departments", () => {
  it("gives a person with no grant the whole team", () => {
    expect(fixture().host.grantFor("ada@acme.test")).toBeNull();
  });

  it("maps a grant's ids to the departments' current names, General as an empty name", () => {
    const { host } = fixture();
    expect(host.change({ entry: "ada@acme.test", departments: ["Sales", ""] })).toEqual({ ok: true });
    expect(names(host, "ada@acme.test")).toEqual(["", "Sales"]);
    expect(host.grantFor("bob@acme.test")).toBeNull();
  });

  it("keeps a department in the grant when the department is renamed", () => {
    const { host, state } = fixture();
    host.change({ entry: "ada@acme.test", departments: ["Sales"] });
    state.sections = ["Revenue", "Finance"];
    state.keys = { Revenue: "team:sales", Finance: "team:fin" };
    host.departmentsChanged();
    expect(names(host, "ada@acme.test")).toEqual(["Revenue"]);
    expect(host.view().people["ada@acme.test"]).toEqual({ departments: [{ name: "Revenue", level: "chat" }], bots: [] });
  });

  it("removes a deleted department from every grant and shows nothing when none is left", () => {
    const { host, access, state } = fixture();
    host.change({ entry: "ada@acme.test", departments: ["Sales", "Finance"] });
    host.change({ entry: "bob@acme.test", departments: ["Sales"] });
    state.sections = ["Finance"];
    delete state.keys.Sales;
    host.departmentsChanged();
    expect(access.forPerson("ada@acme.test")?.departments).toEqual([{ id: "team:fin", level: "chat" }]);
    expect(access.forPerson("bob@acme.test")?.departments).toEqual([]);
    expect(names(host, "bob@acme.test")).toEqual([]);
  });

  it("shows no bot to any member when the grants cannot be read", () => {
    const { host } = fixture({ content: "{ broken" });
    expect(names(host, "ada@acme.test")).toEqual([]);
    expect(names(host, undefined)).toEqual([]);
    const bots = [{ id: "s", threadId: "t-s", section: "Sales" }, { id: "g", threadId: "t-g" }];
    const visible = new VisibleSet(bots, [], { kind: "member", email: "ada@acme.test" }, undefined, undefined, host.grantFor("ada@acme.test"));
    expect(bots.filter((bot) => visible.bot(bot.id))).toEqual([]);
    expect(host.walled("Sales")).toBe(true);
    expect(host.view()).toMatchObject({ unreadable: true, people: {} });
    expect(host.change({ entry: "ada@acme.test", departments: ["Sales"] })).toMatchObject({ ok: false, status: 409 });
  });

  it("shows no bot when the department list cannot be read", () => {
    const { host, state } = fixture();
    host.change({ entry: "ada@acme.test", departments: ["Sales"] });
    state.unreadableSections = true;
    expect(names(host, "ada@acme.test")).toEqual([]);
  });

  it("applies no grant on a Team Cloud or hosted workspace", () => {
    const { host, access } = fixture({ elsewhere: true });
    expect(host.change({ entry: "ada@acme.test", departments: ["Sales"] })).toMatchObject({ ok: false, status: 409 });
    access.set("ada@acme.test", { departments: [{ id: "team:sales", level: "chat" }], bots: [] });
    expect(host.grantFor("ada@acme.test")).toBeNull();
    expect(host.walled("Sales")).toBe(false);
    expect(host.view()).toEqual({ available: false, people: {}, unreadable: false });
  });
});

describe("changing a grant", () => {
  it("forgets what each session was shown and closes the streams of the person it names", () => {
    const { host, forget, closed } = fixture();
    host.change({ entry: "ada@acme.test", departments: ["Sales"] });
    expect(forget).toHaveBeenCalledTimes(1);
    expect(closed).toEqual([["ada@acme.test"]]);
    host.change({ entry: "@acme.test", departments: null });
    expect(closed.at(-1)).toEqual(["ada@acme.test", "bob@acme.test"]);
    host.change({ entry: "ada@acme.test", departments: null });
    expect(host.grantFor("ada@acme.test")).toBeNull();
  });

  it("refuses an address that is not one, an empty choice and an unknown department", () => {
    const { host, access } = fixture();
    expect(host.change({ entry: "nobody", departments: ["Sales"] })).toMatchObject({ status: 400 });
    expect(host.change({ entry: "ada@acme.test", departments: [] })).toMatchObject({ status: 400 });
    expect(host.change({ entry: "ada@acme.test", departments: [3] })).toMatchObject({ status: 400 });
    expect(host.change({ entry: "ada@acme.test", departments: ["Legal"] })).toMatchObject({ status: 400 });
    expect(host.change(null)).toMatchObject({ status: 400 });
    expect(access.all()).toEqual({});
  });

  it("closes the streams of people with a grant when a department is renamed or deleted", () => {
    const { host, closed } = fixture();
    host.change({ entry: "ada@acme.test", departments: ["Sales"] });
    closed.length = 0;
    host.departmentsChanged();
    expect(closed).toEqual([["ada@acme.test"]]);
  });
});

describe("walls between departments", () => {
  it("wall every department that any grant names, and no other", () => {
    const { host } = fixture();
    expect(host.walled("Sales")).toBe(false);
    host.change({ entry: "ada@acme.test", departments: ["Sales"] });
    expect(host.walled("Sales")).toBe(true);
    expect(host.walled(" Sales ")).toBe(true);
    expect(host.walled("Finance")).toBe(false);
    expect(host.walled("")).toBe(false);
    host.change({ entry: "ada@acme.test", departments: [""] });
    expect(host.walled("Sales")).toBe(false);
    expect(host.walled("")).toBe(true);
  });
});

describe("refusals", () => {
  it("refuses team files and a restore to a member with a grant, and only to them", () => {
    const { host } = fixture();
    host.change({ entry: "ada@acme.test", departments: ["Sales"] });
    for (const path of ["/api/team-files", "/api/team-files/file", "/api/team-files/delete", "/api/workspace-backup/restore"]) {
      expect(host.refuses(member("ada@acme.test"), path), path).not.toBeNull();
      expect(host.refuses(member("bob@acme.test"), path), path).toBeNull();
    }
    expect(host.refuses(member("ada@acme.test"), "/api/notifications")).toBeNull();
    expect(host.refuses({ kind: "loopback", scopes: ["admin", "client"] } as RequestAuth, "/api/team-files")).toBeNull();
  });

  it("refuses a room in a department outside the grant", () => {
    const { host } = fixture();
    host.change({ entry: "ada@acme.test", departments: ["Sales"] });
    expect(host.sectionRefusal(member("ada@acme.test"), "Sales")).toBeNull();
    expect(host.sectionRefusal(member("ada@acme.test"), "Finance")).not.toBeNull();
    expect(host.sectionRefusal(member("ada@acme.test"), "")).not.toBeNull();
    expect(host.sectionRefusal(member("ada@acme.test"), undefined)).not.toBeNull();
    expect(host.sectionRefusal(member("bob@acme.test"), "Finance")).toBeNull();
  });
});

describe("how many departments one person may have", () => {
  it("refuses more than the file can hold, and keeps the file readable", () => {
    const { host, state } = fixture();
    state.sections = Array.from({ length: 201 }, (_, index) => `Dept ${index}`);
    const refused = host.change({ entry: "ada@acme.test", departments: state.sections });
    expect(refused).toMatchObject({ ok: false, status: 400 });
    expect(host.view().people).toEqual({});
    expect(host.change({ entry: "ada@acme.test", departments: state.sections.slice(0, 200) })).toEqual({ ok: true });
    expect(host.view().unreadable).toBe(false);
  });
});


const SALES = { name: "Sales", level: "chat" as const };
const asked = (departments: Array<{ name: string; level: "view" | "chat" }>, bots: Array<{ id: string; level: "view" | "chat" }> = []) => ({ entry: "ada@acme.test", access: { departments, bots } });

describe("the grant body", () => {
  it("stores departments and bots with their levels and shows them back", () => {
    const { host, access } = fixture();
    expect(host.change(asked([{ name: "Sales", level: "view" }, { name: "", level: "chat" }], [{ id: "f", level: "chat" }]))).toEqual({ ok: true });
    expect(access.forPerson("ada@acme.test")).toEqual({ departments: [{ id: "team:sales", level: "view" }, { id: "", level: "chat" }], bots: [{ id: "f", level: "chat" }] });
    expect(host.view().people["ada@acme.test"]).toEqual({ departments: [{ name: "", level: "chat" }, { name: "Sales", level: "view" }], bots: [{ id: "f", level: "chat" }] });
    const grant = host.grantFor("ada@acme.test")!;
    expect(grant.departments.get("Sales")).toBe("view");
    expect(grant.bots.get("f")).toBe("chat");
  });

  it("still accepts the old body, with level chat for each department", () => {
    const { host, access } = fixture();
    expect(host.change({ entry: "ada@acme.test", departments: ["Sales"] })).toEqual({ ok: true });
    expect(access.forPerson("ada@acme.test")).toEqual({ departments: [{ id: "team:sales", level: "chat" }], bots: [] });
  });

  it("gives the whole team back for access null", () => {
    const { host } = fixture();
    host.change(asked([SALES]));
    expect(host.change({ entry: "ada@acme.test", access: null })).toEqual({ ok: true });
    expect(host.grantFor("ada@acme.test")).toBeNull();
  });

  it.each([
    ["an entry that is not an address", { entry: "ada", access: { departments: [SALES], bots: [] } }],
    ["no choice at all", { entry: "ada@acme.test" }],
    ["no department and no bot", { entry: "ada@acme.test", access: { departments: [], bots: [] } }],
    ["a level that is not view or chat", { entry: "ada@acme.test", access: { departments: [{ name: "Sales", level: "edit" }], bots: [] } }],
    ["a bot with a missing level", { entry: "ada@acme.test", access: { departments: [], bots: [{ id: "f" }] } }],
    ["a body that is not an object", null],
  ])("answers 400 and stores nothing for %s", (_name, body) => {
    const { host, access, admitted } = fixture();
    expect(host.change(body)).toMatchObject({ ok: false, status: 400 });
    expect(access.all()).toEqual({});
    expect(admitted).toEqual([]);
  });

  it("answers 400 and stores nothing for a department or bot that does not exist (AC-14)", () => {
    const { host, access, path, admitted } = fixture();
    host.change(asked([SALES]));
    const before = readFileSync(path, "utf8");
    expect(host.change(asked([{ name: "Legal", level: "chat" }]))).toMatchObject({ ok: false, status: 400 });
    expect(host.change(asked([SALES], [{ id: "ghost", level: "chat" }]))).toMatchObject({ ok: false, status: 400 });
    expect(host.change(asked([], [{ id: "ghost", level: "view" }]))).toMatchObject({ ok: false, status: 400 });
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(access.forPerson("ada@acme.test")?.bots).toEqual([]);
    expect(admitted).toEqual([]);
  });

  it("answers 400 and stores nothing for more than 200 departments or 200 bots (AC-15)", () => {
    const { host, state, bots, path } = fixture();
    state.sections = Array.from({ length: 201 }, (_, index) => `Dept ${index}`);
    expect(host.change(asked(state.sections.map((name) => ({ name, level: "chat" as const }))))).toMatchObject({ ok: false, status: 400 });
    for (let index = 0; index < 201; index++) bots.push({ id: `bulk-${index}`, name: `Bulk ${index}`, threadId: `t-${index}` });
    expect(host.change(asked([], bots.slice(3).map((bot) => ({ id: bot.id, level: "chat" as const }))))).toMatchObject({ ok: false, status: 400 });
    expect(host.view().people).toEqual({});
    expect(() => readFileSync(path, "utf8")).toThrow();
    expect(host.change(asked([], bots.slice(3, 203).map((bot) => ({ id: bot.id, level: "view" as const }))))).toEqual({ ok: true });
    expect(host.view().unreadable).toBe(false);
  });
});

const admitting = (bots: Array<{ id: string; level: "view" | "chat" }>, extra: Record<string, unknown> = {}) => ({ ...asked([], bots), ...extra });
const ADA = "ada@acme.test";

describe("inviting a person to a bot", () => {
  it("answers 400 and stores nothing when a bot needs the address and the admin did not confirm (AC-06)", () => {
    const { host, bots, access, admitted, rows } = fixture();
    bots[0]!.visibility = "admins";
    bots[1]!.visibility = { people: ["bob@acme.test"] };
    const result = host.change(admitting([{ id: "s", level: "chat" }, { id: "f", level: "view" }]));
    expect(result).toEqual({ ok: false, status: 400, error: "Inviting adds this person to the people who can use Sam, Fin. Confirm to continue." });
    expect(access.all()).toEqual({});
    expect(admitted).toEqual([]);
    expect(rows).toEqual([]);
  });

  it("adds the address to a confirmed bot, remembers it, and logs the audience and the person (AC-06)", () => {
    const { host, bots, access, admitted, rows } = fixture();
    bots[0]!.visibility = "admins";
    bots[1]!.visibility = { people: ["bob@acme.test"] };
    expect(host.change(admitting([{ id: "s", level: "chat" }, { id: "f", level: "view" }], { admitBots: true }))).toEqual({ ok: true });
    expect(admitted).toEqual([{ id: "s", visibility: { people: [ADA] } }, { id: "f", visibility: { people: ["bob@acme.test", ADA] } }]);
    expect(access.all()[ADA]?.admitted).toEqual(["s", "f"]);
    expect(rows.map((row) => row.action)).toEqual(["visibility.update", "visibility.update", "people.update"]);
    expect(rows[0]).toMatchObject({ target: { kind: "bot", id: "s", name: "Sam" }, before: { visibility: "admins" }, after: { visibility: { people: [ADA] } } });
    expect(rows[2]).toEqual({
      category: "people", action: "people.update", target: { kind: "person", name: ADA }, changed: ["access"],
      before: { access: "whole team" },
      after: { access: { departments: [], bots: [{ id: "s", level: "chat" }, { id: "f", level: "view" }] } },
    });
  });

  it("takes the address out of the bot again when the grant is removed (AC-06)", () => {
    const { host, bots, access, admitted, rows } = fixture();
    bots[0]!.visibility = "admins";
    bots[1]!.visibility = { people: ["bob@acme.test"] };
    host.change(admitting([{ id: "s", level: "chat" }, { id: "f", level: "chat" }], { admitBots: true }));
    admitted.length = 0;
    rows.length = 0;
    expect(host.change({ entry: ADA, access: null })).toEqual({ ok: true });
    expect(bots[0]!.visibility).toBe("admins");
    expect(bots[1]!.visibility).toEqual({ people: ["bob@acme.test"] });
    expect(admitted).toEqual([{ id: "s", visibility: "admins" }, { id: "f", visibility: { people: ["bob@acme.test"] } }]);
    expect(access.all()).toEqual({});
    expect(rows.at(-1)).toMatchObject({ action: "people.update", before: { access: { bots: [{ id: "s" }, { id: "f" }] } }, after: { access: "whole team" } });
  });

  it("releases only the bots a change drops, and keeps the bots it keeps", () => {
    const { host, bots, access, admitted } = fixture();
    bots[0]!.visibility = "admins";
    bots[1]!.visibility = "admins";
    host.change(admitting([{ id: "s", level: "chat" }, { id: "f", level: "chat" }], { admitBots: true }));
    admitted.length = 0;
    expect(host.change(admitting([{ id: "s", level: "view" }]))).toEqual({ ok: true });
    expect(admitted).toEqual([{ id: "f", visibility: "admins" }]);
    expect(bots[0]!.visibility).toEqual({ people: [ADA] });
    expect(access.all()[ADA]?.admitted).toEqual(["s"]);
  });

  it("never releases a bot that already had the address before the invite", () => {
    const { host, bots, access, admitted } = fixture();
    bots[0]!.visibility = { people: [ADA] };
    expect(host.change(admitting([{ id: "s", level: "chat" }]))).toEqual({ ok: true });
    expect(access.all()[ADA]?.admitted).toBeUndefined();
    expect(host.change({ entry: ADA, access: null })).toEqual({ ok: true });
    expect(admitted).toEqual([]);
    expect(bots[0]!.visibility).toEqual({ people: [ADA] });
  });

  it("leaves a bot for everyone as it is, with no confirmation (AC-06)", () => {
    const { host, bots, admitted } = fixture();
    bots[0]!.visibility = { people: [ADA] };
    bots[1]!.visibility = { people: ["@acme.test"] };
    expect(host.change(admitting([{ id: "s", level: "chat" }, { id: "f", level: "chat" }, { id: "g", level: "chat" }]))).toEqual({ ok: true });
    expect(admitted).toEqual([]);
  });

  it("answers 400 and stores nothing for a domain entry and a bot that is not shared with everyone", () => {
    const { host, bots, access, admitted } = fixture();
    bots[2]!.visibility = "admins";
    const body = { entry: "@acme.test", admitBots: true, access: { departments: [], bots: [{ id: "g", level: "chat" }] } };
    expect(host.change(body)).toEqual({ ok: false, status: 400, error: "To give access to Gus, invite each person by their own address." });
    expect(access.all()).toEqual({});
    expect(admitted).toEqual([]);
  });

  it("gives a domain entry a bot that is shared with everyone, with no admission", () => {
    const { host, access, admitted } = fixture();
    expect(host.change({ entry: "@acme.test", access: { departments: [], bots: [{ id: "g", level: "chat" }] } })).toEqual({ ok: true });
    expect(admitted).toEqual([]);
    expect(access.all()["@acme.test"]?.admitted).toBeUndefined();
  });

  it("stores nothing when a bot cannot take one more person", () => {
    const { host, bots, access, admitted } = fixture();
    bots[0]!.visibility = { people: Array.from({ length: 500 }, (_, index) => `p${index}@acme.test`) };
    expect(host.change(asked([], [{ id: "s", level: "chat" }]))).toMatchObject({ ok: false, status: 400 });
    expect(access.all()).toEqual({});
    expect(admitted).toEqual([]);
  });

  it("forgets what each session was shown and closes the person's streams after the change (AC-12)", () => {
    const { host, closed, forget } = fixture();
    host.change(asked([], [{ id: "s", level: "chat" }]));
    expect(forget).toHaveBeenCalledTimes(1);
    expect(closed).toEqual([["ada@acme.test"]]);
  });
});

describe("a deleted bot", () => {
  it("leaves every grant and closes the streams of the people whose grant named it (AC-11)", () => {
    const { host, access, closed } = fixture();
    host.change(asked([SALES], [{ id: "f", level: "chat" }]));
    host.change({ entry: "bob@acme.test", access: { departments: [], bots: [{ id: "s", level: "chat" }] } });
    closed.length = 0;
    host.botDeleted("f");
    expect(access.forPerson("ada@acme.test")?.bots).toEqual([]);
    expect(access.forPerson("bob@acme.test")?.bots).toEqual([{ id: "s", level: "chat" }]);
    expect(closed).toEqual([["ada@acme.test"]]);
  });

  it("keeps the entry when its last bot goes: the person then sees nothing", () => {
    const { host, access, closed } = fixture();
    host.change(asked([], [{ id: "f", level: "chat" }]));
    closed.length = 0;
    host.botDeleted("f");
    expect(access.forPerson("ada@acme.test")).toEqual({ departments: [], bots: [] });
    expect(names(host, "ada@acme.test")).toEqual([]);
    host.botDeleted("f");
    expect(closed).toEqual([["ada@acme.test"]]);
  });
});

describe("the wall around a bot grant", () => {
  const sees = (id: string) => ({ id, section: id === "s" ? "Sales" : id === "f" ? "Finance" : "", visibility: undefined as unknown });

  it("stops a bot the person sees from reaching a bot they do not see (AC-13)", () => {
    const { host } = fixture();
    host.change(asked([], [{ id: "s", level: "chat" }]));
    expect(host.wallBetween(sees("s"), sees("f"))).toBe("grant");
    expect(host.wallBetween(sees("s"), sees("g"))).toBe("grant");
  });

  it("lets a bot reach another bot the person sees, and lets an unseen bot reach in", () => {
    const { host } = fixture();
    host.change(asked([], [{ id: "s", level: "chat" }, { id: "f", level: "view" }]));
    expect(host.wallBetween(sees("s"), sees("f"))).toBeNull();
    expect(host.wallBetween(sees("g"), sees("s"))).toBeNull();
    expect(host.wallBetween(sees("g"), sees("f"))).toBeNull();
  });

  it("counts the person's audience: a bot they may not see is outside the grant even when it is in a granted department", () => {
    const { host } = fixture();
    host.change(asked([SALES], [{ id: "f", level: "chat" }]));
    expect(host.wallBetween({ id: "s2", section: "Sales" }, { id: "s3", section: "Sales", visibility: "admins" })).toBe("grant");
    expect(host.wallBetween({ id: "s2", section: "Sales" }, { id: "s3", section: "Sales", visibility: { people: ["ada@acme.test"] } })).toBeNull();
  });

  it("adds no grant wall for a grant with departments only, and reports the department wall first", () => {
    const { host } = fixture();
    host.change(asked([SALES]));
    expect(host.wallBetween(sees("g"), sees("f"))).toBeNull();
    expect(host.wallBetween(sees("s"), sees("f"))).toBe("department");
  });

  it("walls every hand-off when the grants cannot be read, and none on a Team Cloud", () => {
    expect(fixture({ content: "{ broken" }).host.wallBetween(sees("g"), { id: "x" })).toBe("grant");
    expect(fixture({ content: "{ broken" }).host.wallBetween(sees("g"), sees("f"))).toBe("department");
    const { host, access } = fixture({ elsewhere: true });
    access.set("ada@acme.test", { departments: [], bots: [{ id: "s", level: "chat" }] });
    expect(host.wallBetween(sees("s"), sees("f"))).toBeNull();
  });

  it("walls a bot that some people of a domain grant may see from a bot that not all of them see", () => {
    const { host, access } = fixture();
    access.set("@acme.test", { departments: [], bots: [{ id: "s", level: "chat" }, { id: "f", level: "chat" }] });
    host.changed();
    const onlyAda = { ...sees("s"), visibility: { people: ["ada@acme.test"] } };
    expect(host.wallBetween(onlyAda, sees("g"))).toBe("grant");
    expect(host.wallBetween(onlyAda, { ...sees("f"), visibility: { people: ["ada@acme.test"] } })).toBe("grant");
    expect(host.wallBetween(onlyAda, sees("f"))).toBeNull();
    expect(host.wallBetween({ ...sees("s"), visibility: { people: ["@acme.test"] } }, sees("f"))).toBeNull();
  });

  it("follows a change at once", () => {
    const { host } = fixture();
    host.change(asked([], [{ id: "s", level: "chat" }]));
    expect(host.wallBetween(sees("s"), sees("f"))).toBe("grant");
    host.change({ entry: "ada@acme.test", access: null });
    expect(host.wallBetween(sees("s"), sees("f"))).toBeNull();
  });
});

describe("relaying a message for a limited person", () => {
  const ADA = "ada@acme.test";
  const sales = (visibility?: unknown) => ({ id: "s", name: "Sam", section: "Sales", ...(visibility !== undefined ? { visibility } : {}) }) as { id: string; name: string; section: string; visibility?: never };
  const give = (entry: string, departments: Array<{ name: string; level: "view" | "chat" }>, bots: Array<{ id: string; level: "view" | "chat" }> = []) => ({ entry, access: { departments, bots }, admitBots: true });
  const refusal = `${ADA} can't chat with Sam here.`;

  it("passes for an admin and for a person with no grant", () => {
    const { host } = fixture();
    host.change(give("bob@acme.test", [], [{ id: "f", level: "view" }]));
    expect(host.relayRefusal(sales(), "bob@acme.test", true)).toBeNull();
    expect(host.relayRefusal(sales(), ADA, false)).toBeNull();
  });

  it("passes a relay that names nobody only when every grant lets its people chat with the bot", () => {
    const unnamed = "Someone outside the people added can't chat with Sam here.";
    const none = fixture().host;
    expect(none.relayRefusal(sales(), undefined, false)).toBeNull();
    const { host } = fixture();
    host.change(give("bob@acme.test", [], [{ id: "f", level: "chat" }]));
    expect(host.relayRefusal(sales(), undefined, false)).toBe(unnamed);
    host.change(give("bob@acme.test", [{ name: "Sales", level: "chat" }]));
    expect(host.relayRefusal(sales(), undefined, false)).toBeNull();
    expect(host.relayRefusal(sales({ people: ["cy@other.test"] }), undefined, false)).toBe(unnamed);
    expect(host.relayRefusal(sales({ people: ["bob@acme.test"] }), undefined, false)).toBeNull();
    host.change(give(ADA, [], [{ id: "s", level: "view" }]));
    expect(host.relayRefusal(sales(), undefined, false)).toBe(unnamed);
    expect(fixture({ content: "{ broken" }).host.relayRefusal(sales(), undefined, false)).toBe(unnamed);
  });

  it("refuses a bot the grant gives as view, and passes one it gives as chat", () => {
    const { host } = fixture();
    host.change(give(ADA, [], [{ id: "s", level: "view" }]));
    expect(host.relayRefusal(sales(), ADA, false)).toBe(refusal);
    host.change(give(ADA, [], [{ id: "s", level: "chat" }]));
    expect(host.relayRefusal(sales(), ADA, false)).toBeNull();
  });

  it("passes a bot whose department the grant gives as chat, and refuses a bot outside the grant", () => {
    const { host } = fixture();
    host.change(give(ADA, [{ name: "Sales", level: "chat" }]));
    expect(host.relayRefusal(sales(), ADA, false)).toBeNull();
    expect(host.relayRefusal({ id: "f", name: "Fin", section: "Finance" }, ADA, false)).toBe(`${ADA} can't chat with Fin here.`);
  });

  it("refuses when the bot's audience leaves the person out, even with a chat grant", () => {
    const { host } = fixture();
    host.change(give(ADA, [], [{ id: "s", level: "chat" }]));
    expect(host.relayRefusal(sales({ people: ["cy@other.test"] }), ADA, false)).toBe(refusal);
    expect(host.relayRefusal(sales({ people: [ADA] }), ADA, false)).toBeNull();
  });

  it("treats a grant for a @domain like a grant for the address", () => {
    const { host } = fixture();
    host.change(give("@acme.test", [], [{ id: "s", level: "chat" }]));
    expect(host.relayRefusal(sales(), ADA, false)).toBeNull();
    expect(host.relayRefusal({ id: "f", name: "Fin", section: "Finance" }, ADA, false)).toBe(`${ADA} can't chat with Fin here.`);
  });

  it("refuses when the grants cannot be read", () => {
    const { host } = fixture({ content: "{ broken" });
    expect(host.relayRefusal(sales(), ADA, false)).toBe(refusal);
  });
});
