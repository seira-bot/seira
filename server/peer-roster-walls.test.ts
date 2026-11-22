import { afterEach, describe, expect, it } from "vitest";

import { PEER_ACCESS_HELP, canReach, reachablePeers, resolveTeammate, setDepartmentWalls, unreachableTeammate, walledOff, type RosterMember } from "./peer-roster.ts";

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
});

describe("General", () => {
  it("is walled like any department when a grant names it: its bots, the Chief too, reach only General", () => {
    setDepartmentWalls((section) => section === "");
    expect(canReach(chief, sales)).toBe(false);
    expect(canReach(chief, fin)).toBe(false);
    expect(walledOff(chief, sales)).toMatch(/another department/);
    expect(reachablePeers(all, chief)).toEqual([]);
    expect(canReach(sales, chief)).toBe(true);
  });
});

describe("the access help a bot reads", () => {
  it("says a bot in a limited department reaches only its own department, without internal words", () => {
    expect(PEER_ACCESS_HELP).toContain("limited for an invited person can reach only bots in its own department");
    expect(PEER_ACCESS_HELP).not.toMatch(/Every bot can reach every other bot/);
    expect(PEER_ACCESS_HELP).not.toMatch(/grant|memoryKey|wall|scope|endpoint/i);
  });
});
