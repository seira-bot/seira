import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { accessEntry, DepartmentAccess } from "./department-access.ts";

const root = mkdtempSync(join(tmpdir(), "dept-access-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
const file = () => join(root, `grants-${counter++}.json`);
const chat = (...ids: string[]) => ids.map((id) => ({ id, level: "chat" as const }));
const grant = (departments: string[], bots: string[] = []) => ({ departments: chat(...departments), bots: chat(...bots) });

describe("DepartmentAccess", () => {
  it("starts empty: nobody is limited and the file is readable", () => {
    const access = new DepartmentAccess(file());
    expect(access.unreadable).toBe(false);
    expect(access.forPerson("ada@acme.test")).toBeNull();
    expect(access.all()).toEqual({});
  });

  it("saves a grant to a private file and reads it back", () => {
    const path = file();
    const access = new DepartmentAccess(path);
    access.set("ada@acme.test", { departments: [{ id: "team:1", level: "view" }, { id: "", level: "chat" }], bots: chat("b1") });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const saved = { departments: [{ id: "team:1", level: "view" }, { id: "", level: "chat" }], bots: [{ id: "b1", level: "chat" }] };
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 2, people: { "ada@acme.test": saved } });
    expect(new DepartmentAccess(path).forPerson("ADA@acme.test")).toEqual(saved);
  });

  it("reads a version 1 file as version 2 with chat per department (AC-02)", () => {
    const path = file();
    writeFileSync(path, JSON.stringify({ version: 1, people: { "ada@acme.test": { departments: ["team:1", ""] }, "@acme.test": { departments: [] } } }));
    const access = new DepartmentAccess(path);
    expect(access.unreadable).toBe(false);
    expect(access.forPerson("ada@acme.test")).toEqual(grant(["team:1", ""]));
    expect(access.forPerson("bob@acme.test")).toEqual(grant([]));
  });

  it("writes version 2 with mode 0600 when a version 1 file changes (AC-03)", () => {
    const path = file();
    writeFileSync(path, JSON.stringify({ version: 1, people: { "ada@acme.test": { departments: ["team:1"] } } }), { mode: 0o644 });
    const access = new DepartmentAccess(path);
    access.set("bob@acme.test", grant([], ["b1"]));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 2,
      people: { "ada@acme.test": grant(["team:1"]), "bob@acme.test": grant([], ["b1"]) },
    });
  });

  it("collapses an item named twice to the higher level", () => {
    const access = new DepartmentAccess(file());
    access.set("ada@acme.test", { departments: [{ id: "d", level: "view" }, { id: "d", level: "chat" }], bots: [{ id: "b", level: "chat" }, { id: "b", level: "view" }, { id: "c", level: "view" }] });
    expect(access.forPerson("ada@acme.test")).toEqual({ departments: [{ id: "d", level: "chat" }], bots: [{ id: "b", level: "chat" }, { id: "c", level: "view" }] });
  });

  it("removes a deleted bot from every grant and keeps an emptied grant (AC-11)", () => {
    const path = file();
    const access = new DepartmentAccess(path);
    access.set("ada@acme.test", grant(["team:1"], ["b1", "b2"]));
    access.set("bob@acme.test", grant([], ["b1"]));
    access.set("cy@acme.test", grant(["team:1"]));
    expect(access.dropBot("b1")).toBe(true);
    expect(access.forPerson("ada@acme.test")).toEqual(grant(["team:1"], ["b2"]));
    expect(access.forPerson("bob@acme.test")).toEqual(grant([]));
    expect(access.dropBot("b1")).toBe(false);
    expect(new DepartmentAccess(path).forPerson("bob@acme.test")).toEqual(grant([]));
  });

  it("keeps the bots an invite admitted through the file, and reads a file without them", () => {
    const path = file();
    const access = new DepartmentAccess(path);
    access.set("ada@acme.test", { ...grant([], ["b1", "b2"]), admitted: ["b1", "b1", "b2"] });
    access.set("bob@acme.test", { ...grant([], ["b1"]), admitted: [] });
    const people = JSON.parse(readFileSync(path, "utf8")).people;
    expect(people["ada@acme.test"].admitted).toEqual(["b1", "b2"]);
    expect("admitted" in people["bob@acme.test"]).toBe(false);
    expect(new DepartmentAccess(path).forPerson("ada@acme.test")).toEqual({ ...grant([], ["b1", "b2"]), admitted: ["b1", "b2"] });
    writeFileSync(path, JSON.stringify({ version: 2, people: { "cy@acme.test": grant([], ["b1"]) } }));
    const older = new DepartmentAccess(path);
    expect(older.unreadable).toBe(false);
    expect(older.forPerson("cy@acme.test")).toEqual(grant([], ["b1"]));
  });

  it("removes a deleted bot from the admitted list too", () => {
    const path = file();
    const access = new DepartmentAccess(path);
    access.set("ada@acme.test", { ...grant([], ["b1", "b2"]), admitted: ["b1", "b2"] });
    expect(access.dropBot("b1")).toBe(true);
    expect(access.forPerson("ada@acme.test")).toEqual({ ...grant([], ["b2"]), admitted: ["b2"] });
    access.dropBot("b2");
    expect("admitted" in JSON.parse(readFileSync(path, "utf8")).people["ada@acme.test"]).toBe(false);
  });

  it("matches the exact address before its @domain", () => {
    const access = new DepartmentAccess(file());
    access.set("@acme.test", grant(["team:domain"]));
    access.set("ada@acme.test", grant(["team:ada"]));
    expect(access.forPerson("ada@acme.test")).toEqual(grant(["team:ada"]));
    expect(access.forPerson("bob@acme.test")).toEqual(grant(["team:domain"]));
    expect(access.forPerson("bob@other.test")).toBeNull();
    expect(access.forPerson(undefined)).toBeNull();
  });

  it("gives the whole team back when a grant is set to null", () => {
    const access = new DepartmentAccess(file());
    access.set("ada@acme.test", grant(["team:1"]));
    access.set("ada@acme.test", null);
    expect(access.forPerson("ada@acme.test")).toBeNull();
  });

  it("drops the departments that no longer exist from every grant, and keeps an emptied grant", () => {
    const access = new DepartmentAccess(file());
    access.set("ada@acme.test", grant(["team:1", "team:2"], ["b1"]));
    access.set("bob@acme.test", grant(["team:2"]));
    expect(access.keepOnly((id) => id === "team:1")).toBe(true);
    expect(access.forPerson("ada@acme.test")).toEqual(grant(["team:1"], ["b1"]));
    expect(access.forPerson("bob@acme.test")).toEqual(grant([]));
    expect(access.keepOnly((id) => id === "team:1")).toBe(false);
  });

  it.each([
    ["not json", "{"],
    ["a wrong version", JSON.stringify({ version: 3, people: {} })],
    ["an extra field", JSON.stringify({ version: 1, people: {}, extra: 1 })],
    ["a grant that is not a list", JSON.stringify({ version: 1, people: { "a@b.test": { departments: "team:1" } } })],
    ["a version 2 grant without bots", JSON.stringify({ version: 2, people: { "a@b.test": { departments: [] } } })],
    ["a level that is not view or chat", JSON.stringify({ version: 2, people: { "a@b.test": { departments: [{ id: "d", level: "edit" }], bots: [] } } })],
    ["more than 200 bots", JSON.stringify({ version: 2, people: { "a@b.test": { departments: [], bots: chat(...Array.from({ length: 201 }, (_, index) => `b${index}`)) } } })],
  ])("is unreadable for %s, and refuses to overwrite it (AC-16)", (_name, content) => {
    const path = file();
    writeFileSync(path, content);
    const access = new DepartmentAccess(path);
    expect(access.unreadable).toBe(true);
    expect(access.forPerson("ada@acme.test")).toBeNull();
    expect(() => access.set("ada@acme.test", grant(["team:1"]))).toThrow();
    expect(access.keepOnly(() => false)).toBe(false);
    expect(access.dropBot("b1")).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(content);
  });

  it("is unreadable when the file is a link or too large", () => {
    const target = file();
    writeFileSync(target, JSON.stringify({ version: 1, people: {} }));
    const link = join(root, "link.json");
    symlinkSync(target, link);
    expect(new DepartmentAccess(link).unreadable).toBe(true);
    const big = file();
    writeFileSync(big, " ".repeat(4_000_001));
    expect(new DepartmentAccess(big).unreadable).toBe(true);
  });

  it("is unreadable when the file cannot be opened", () => {
    const path = file();
    writeFileSync(path, JSON.stringify({ version: 1, people: {} }));
    chmodSync(path, 0o000);
    const readable = (() => { try { readFileSync(path); return true; } catch { return false; } })();
    expect(new DepartmentAccess(path).unreadable).toBe(!readable);
    chmodSync(path, 0o600);
    expect(existsSync(path)).toBe(true);
  });
});

describe("accessEntry", () => {
  it("accepts an address or @domain and lower-cases it", () => {
    expect(accessEntry(" Ada@Acme.Test ")).toBe("ada@acme.test");
    expect(accessEntry("@Acme.test")).toBe("@acme.test");
    for (const bad of ["", "ada", "ada@", "a b@c.test", 7, null, undefined]) expect(accessEntry(bad)).toBeNull();
  });
});
