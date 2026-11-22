import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DepartmentFolders } from "./department-folders.ts";

let root = "";
let file = "";
const sales = { limited: true, folders: [{ path: "/work/sales", write: true }] };

beforeAll(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "department-folders-"))); });
afterAll(() => rmSync(root, { recursive: true, force: true }));
const fresh = (name: string) => { file = join(root, `${name}.json`); return new DepartmentFolders(file); };

describe("DepartmentFolders", () => {
  it("reads empty from a missing, broken, or oversized file", () => {
    expect(fresh("missing").all()).toEqual({});
    writeFileSync(join(root, "broken.json"), "{not json");
    expect(new DepartmentFolders(join(root, "broken.json")).all()).toEqual({});
    writeFileSync(join(root, "shape.json"), JSON.stringify({ version: 1, departments: { A: { limited: "yes" } } }));
    expect(new DepartmentFolders(join(root, "shape.json")).all()).toEqual({});
    writeFileSync(join(root, "big.json"), JSON.stringify({ version: 1, departments: {}, pad: "x".repeat(210_000) }));
    expect(new DepartmentFolders(join(root, "big.json")).all()).toEqual({});
  });

  it("refuses a symlinked file", () => {
    writeFileSync(join(root, "real.json"), JSON.stringify({ version: 1, departments: { Sales: sales } }));
    symlinkSync(join(root, "real.json"), join(root, "link.json"));
    expect(new DepartmentFolders(join(root, "link.json")).all()).toEqual({});
  });

  it("saves with mode 0600 and survives a restart", () => {
    const folders = fresh("persist");
    folders.set("Sales", sales);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, departments: { Sales: sales } });
    expect(new DepartmentFolders(file).get("Sales")).toEqual(sales);
  });

  it("removes an entry on null or an empty setting", () => {
    const folders = fresh("clear");
    folders.set("Sales", sales);
    folders.set("Sales", { limited: false, folders: [] });
    expect(folders.get("Sales")).toBeUndefined();
    folders.set("Ops", sales);
    folders.set("Ops", null);
    expect(new DepartmentFolders(file).all()).toEqual({});
  });

  it("follows a department rename and delete in the file", () => {
    const folders = fresh("sync");
    folders.set("Sales", sales);
    folders.rename("Sales", "Revenue");
    expect(new DepartmentFolders(file).all()).toEqual({ Revenue: sales });
    folders.remove("Revenue");
    expect(new DepartmentFolders(file).all()).toEqual({});
  });

  it("does not hand out its inner state", () => {
    const folders = fresh("copy");
    folders.set("Sales", sales);
    folders.get("Sales")!.folders.push({ path: "/x", write: false });
    expect(folders.get("Sales")).toEqual(sales);
  });
});
