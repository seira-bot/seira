import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { currentFormat, currentGoalTags, currentStateKeys } from "../electron/legacy-names.mjs";
import { readShareFolder } from "./share-folder.ts";
import { isPackageDocument, parsePackageDocument } from "./package-format.ts";
import { manifestDetails } from "./share-details.ts";
import { parseTeamBackup } from "./team-backup.ts";

const fixture = (): any => JSON.parse(readFileSync(join(import.meta.dirname, "package-fixtures", "legacy-team.v1.json"), "utf8"));
const earlier = () => ({ ...fixture(), format: "openmaus.package" });

describe("user files an earlier version wrote", () => {
  it("maps each format id and leaves current and unknown ids alone", () => {
    expect(currentFormat("openmaus.package")).toBe("seira.package");
    expect(currentFormat("seira.package")).toBe("seira.package");
    expect(currentFormat("other")).toBe("other");
    expect(currentFormat(3)).toBe(3);
  });

  it("opens a package with the old format id, and a current one the same way", () => {
    expect(isPackageDocument(earlier())).toBe(true);
    expect(parsePackageDocument(earlier()).package.id).toBe(parsePackageDocument(fixture()).package.id);
  });

  it("reads an old package file name in a folder", () => {
    const files = { "signal.openmaus.json": JSON.stringify(earlier()) };
    const shared = readShareFolder(files);
    expect(shared.kind).toBe("package");
  });

  it("reads an old team file as a team", () => {
    const team = { format: "openmaus.team", version: 1, team: { name: "T", members: [{ key: "a", name: "A" }] } };
    expect(manifestDetails(team)?.name).toBeTruthy();
  });

  it("refuses an old backup with a wrong format id as before", () => {
    expect(() => parseTeamBackup({ format: "openmaus.nothing", version: 1 })).toThrow("Invalid backup");
  });

  it("maps goal tags and saved keys", () => {
    expect(currentGoalTags("a <openmaus-goal>{}</openmaus-goal> b")).toBe("a <seira-goal>{}</seira-goal> b");
    expect(currentGoalTags("plain")).toBe("plain");
    expect(currentStateKeys({ "omb-x": "1", "seira-x": "2", "omb-y": "3" })).toEqual({ "seira-x": "2", "seira-y": "3" });
  });
});
