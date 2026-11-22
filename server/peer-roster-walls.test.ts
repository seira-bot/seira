import { afterEach, describe, expect, it } from "vitest";

import { canReach, reachablePeers, resolveTeammate, setDepartmentWalls, unreachableTeammate, walledOff, type RosterMember } from "./peer-roster.ts";

const bot = (id: string, section?: string): RosterMember => ({ id, name: `Bot ${id}`, ...(section !== undefined ? { section } : {}) });
const sales = bot("sales", "Sales");
const sales2 = bot("sales2", "Sales");
const fin = bot("fin", "Finance");
const chief = bot("chief");
const all = [sales, sales2, fin, chief];

afterEach(() => setDepartmentWalls(() => false));

describe("with no wall", () => {
  it("lets every bot reach every other bot", () => {
    expect(canReach(sales, fin)).toBe(true);
    expect(walledOff(sales, fin)).toBeUndefined();
  });
});

describe("a walled department", () => {
  const wall = (...names: string[]) => setDepartmentWalls((section) => names.includes(section));

  it("keeps its bots from reaching a bot of another department", () => {
    wall("Sales");
    expect(canReach(sales, fin)).toBe(false);
    expect(canReach(sales, chief)).toBe(false);
    expect(canReach(sales, sales2)).toBe(true);
    expect(reachablePeers(all, sales).map((peer) => peer.id)).toEqual(["sales2"]);
  });

  it("lets a bot from outside reach in", () => {
    wall("Sales");
    expect(canReach(fin, sales)).toBe(true);
    expect(canReach(chief, sales)).toBe(true);
    expect(reachablePeers(all, chief).map((peer) => peer.id).sort()).toEqual(["fin", "sales", "sales2"]);
  });

  it("refuses a hand-off that would cross the wall and says nothing about the other bot's setup", () => {
    wall("Sales");
    expect(walledOff(sales, fin)).toMatch(/nothing was sent/);
    expect(walledOff(sales, sales2)).toBeUndefined();
    expect(walledOff(fin, sales)).toBeUndefined();
    expect(walledOff(sales, sales)).toBeUndefined();
  });

  it("does not resolve a name outside the wall, and still refuses its id at the hand-off", () => {
    wall("Sales");
    expect(resolveTeammate(all, sales, "Bot fin")).toHaveProperty("error");
    expect(unreachableTeammate(all, sales, "fin")?.id).toBe("fin");
    expect(resolveTeammate(all, sales, "fin")).toEqual({ id: "fin", byName: false });
    expect(walledOff(sales, fin)).toBeDefined();
  });

  it("walls General by its empty name", () => {
    wall("");
    expect(canReach(chief, sales)).toBe(false);
    expect(canReach(sales, chief)).toBe(true);
  });
});
