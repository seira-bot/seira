import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { VisibleSet, type Viewer } from "../bot-visibility.ts";
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
  const bots = [{ id: "s", threadId: "t-s", section: "Sales" }, { id: "f", threadId: "t-f", section: "Finance" }, { id: "g", threadId: "t-g" }];
  const host = createDepartmentAccessHost({
    access,
    sections: () => state.sections,
    keyOf: (name) => { if (state.unreadableSections) throw new Error("unreadable"); return state.keys[name] ?? name; },
    ensureKey: (name) => (state.keys[name] ??= name),
    elsewhere: () => options.elsewhere === true,
    visible: (auth) => new VisibleSet(bots, [], { kind: "member", email: (auth as { session?: { email?: string } }).session?.email } as Viewer, undefined, undefined, host.departmentsFor((auth as { session?: { email?: string } }).session?.email)),
    forgetVisibility: forget,
    closeStreams: (matches) => closed.push(emails.filter(matches)),
  });
  return { host, access, state, forget, closed, path };
}
const member = (email: string) => ({ kind: "session", scopes: ["client"], session: { email } }) as unknown as RequestAuth;

describe("who sees which departments", () => {
  it("gives a person with no grant the whole team", () => {
    expect(fixture().host.departmentsFor("ada@acme.test")).toBeNull();
  });

  it("maps a grant's ids to the departments' current names, General as an empty name", () => {
    const { host } = fixture();
    expect(host.change({ entry: "ada@acme.test", departments: ["Sales", ""] })).toEqual({ ok: true });
    expect([...host.departmentsFor("ada@acme.test")!].sort()).toEqual(["", "Sales"]);
    expect(host.departmentsFor("bob@acme.test")).toBeNull();
  });

  it("keeps a department in the grant when the department is renamed", () => {
    const { host, state } = fixture();
    host.change({ entry: "ada@acme.test", departments: ["Sales"] });
    state.sections = ["Revenue", "Finance"];
    state.keys = { Revenue: "team:sales", Finance: "team:fin" };
    host.departmentsChanged();
    expect([...host.departmentsFor("ada@acme.test")!]).toEqual(["Revenue"]);
    expect(host.view().people["ada@acme.test"]).toEqual(["Revenue"]);
  });

  it("removes a deleted department from every grant and shows nothing when none is left", () => {
    const { host, access, state } = fixture();
    host.change({ entry: "ada@acme.test", departments: ["Sales", "Finance"] });
    host.change({ entry: "bob@acme.test", departments: ["Sales"] });
    state.sections = ["Finance"];
    delete state.keys.Sales;
    host.departmentsChanged();
    expect(access.forPerson("ada@acme.test")).toEqual(["team:fin"]);
    expect(access.forPerson("bob@acme.test")).toEqual([]);
    expect([...host.departmentsFor("bob@acme.test")!]).toEqual([]);
  });

  it("shows no bot to any member when the grants cannot be read", () => {
    const { host } = fixture({ content: "{ broken" });
    expect([...host.departmentsFor("ada@acme.test")!]).toEqual([]);
    expect([...host.departmentsFor(undefined)!]).toEqual([]);
    const bots = [{ id: "s", threadId: "t-s", section: "Sales" }, { id: "g", threadId: "t-g" }];
    const visible = new VisibleSet(bots, [], { kind: "member", email: "ada@acme.test" }, undefined, undefined, host.departmentsFor("ada@acme.test"));
    expect(bots.filter((bot) => visible.bot(bot.id))).toEqual([]);
    expect(host.walled("Sales")).toBe(true);
    expect(host.view()).toMatchObject({ unreadable: true, people: {} });
    expect(host.change({ entry: "ada@acme.test", departments: ["Sales"] })).toMatchObject({ ok: false, status: 409 });
  });

  it("shows no bot when the department list cannot be read", () => {
    const { host, state } = fixture();
    host.change({ entry: "ada@acme.test", departments: ["Sales"] });
    state.unreadableSections = true;
    expect([...host.departmentsFor("ada@acme.test")!]).toEqual([]);
  });

  it("applies no grant on a Team Cloud or hosted workspace", () => {
    const { host, access } = fixture({ elsewhere: true });
    expect(host.change({ entry: "ada@acme.test", departments: ["Sales"] })).toMatchObject({ ok: false, status: 409 });
    access.set("ada@acme.test", ["team:sales"]);
    expect(host.departmentsFor("ada@acme.test")).toBeNull();
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
    expect(host.departmentsFor("ada@acme.test")).toBeNull();
  });

  it("refuses an address that is not one, an empty choice and an unknown department", () => {
    const { host, access } = fixture();
    expect(host.change({ entry: "nobody", departments: ["Sales"] })).toMatchObject({ status: 400 });
    expect(host.change({ entry: "ada@acme.test", departments: [] })).toMatchObject({ status: 400 });
    expect(host.change({ entry: "ada@acme.test", departments: [3] })).toMatchObject({ status: 400 });
    expect(host.change({ entry: "ada@acme.test", departments: ["Legal"] })).toMatchObject({ status: 404 });
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

