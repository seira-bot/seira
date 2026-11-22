import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { accessEntry, DepartmentAccess } from "./department-access.ts";

const root = mkdtempSync(join(tmpdir(), "dept-access-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
const file = () => join(root, `grants-${counter++}.json`);

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
    access.set("ada@acme.test", ["team:1", ""]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, people: { "ada@acme.test": { departments: ["team:1", ""] } } });
    expect(new DepartmentAccess(path).forPerson("ADA@acme.test")).toEqual(["team:1", ""]);
  });

  it("matches the exact address before its @domain", () => {
    const access = new DepartmentAccess(file());
    access.set("@acme.test", ["team:domain"]);
    access.set("ada@acme.test", ["team:ada"]);
    expect(access.forPerson("ada@acme.test")).toEqual(["team:ada"]);
    expect(access.forPerson("bob@acme.test")).toEqual(["team:domain"]);
    expect(access.forPerson("bob@other.test")).toBeNull();
    expect(access.forPerson(undefined)).toBeNull();
  });

  it("gives the whole team back when a grant is set to null", () => {
    const access = new DepartmentAccess(file());
    access.set("ada@acme.test", ["team:1"]);
    access.set("ada@acme.test", null);
    expect(access.forPerson("ada@acme.test")).toBeNull();
  });

  it("drops the departments that no longer exist from every grant, and keeps an emptied grant", () => {
    const access = new DepartmentAccess(file());
    access.set("ada@acme.test", ["team:1", "team:2"]);
    access.set("bob@acme.test", ["team:2"]);
    expect(access.keepOnly((id) => id === "team:1")).toBe(true);
    expect(access.forPerson("ada@acme.test")).toEqual(["team:1"]);
    expect(access.forPerson("bob@acme.test")).toEqual([]);
    expect(access.keepOnly((id) => id === "team:1")).toBe(false);
  });

  it.each([
    ["not json", "{"],
    ["a wrong version", JSON.stringify({ version: 2, people: {} })],
    ["an extra field", JSON.stringify({ version: 1, people: {}, extra: 1 })],
    ["a grant that is not a list", JSON.stringify({ version: 1, people: { "a@b.test": { departments: "team:1" } } })],
  ])("is unreadable for %s, and refuses to overwrite it", (_name, content) => {
    const path = file();
    writeFileSync(path, content);
    const access = new DepartmentAccess(path);
    expect(access.unreadable).toBe(true);
    expect(access.forPerson("ada@acme.test")).toBeNull();
    expect(() => access.set("ada@acme.test", ["team:1"])).toThrow();
    expect(access.keepOnly(() => false)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(content);
  });

  it("is unreadable when the file is a link or too large", () => {
    const target = file();
    writeFileSync(target, JSON.stringify({ version: 1, people: {} }));
    const link = join(root, "link.json");
    symlinkSync(target, link);
    expect(new DepartmentAccess(link).unreadable).toBe(true);
    const big = file();
    writeFileSync(big, " ".repeat(400_001));
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
