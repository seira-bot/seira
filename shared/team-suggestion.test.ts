import { describe, expect, it } from "vitest";

import { pickSuggestion, suggestionPackage, TeamSuggestionError, type TeamSuggestionInput } from "./team-suggestion.ts";

const INPUT: TeamSuggestionInput = {
  department: "Bakery",
  summary: "A small team for a neighbourhood bakery.",
  bots: [
    { name: "Baker Bot", role: "Orders", job: "Tracks the daily orders." },
    { name: "Books", role: "Bookkeeper", job: "Keeps the weekly books." },
    { name: "Post", role: "Social", job: "Writes the weekly post." },
  ],
  groupChats: [{ name: "Morning huddle", members: ["Baker Bot", "Books", "Post"] }, { name: "Alone", members: ["Books"] }],
};

describe("suggestionPackage", () => {
  it("builds a package without a leader, with a room only for two or more known members", () => {
    const pkg = suggestionPackage(INPUT).package;
    expect(pkg.agents.map((agent) => agent.name)).toEqual(["Baker Bot", "Books", "Post"]);
    expect(pkg.team?.leader).toBeUndefined();
    expect(pkg.rooms?.map((room) => room.name)).toEqual(["Morning huddle"]);
  });

  it("refuses a team with no usable bot", () => {
    expect(() => suggestionPackage({ ...INPUT, bots: [{ name: "", role: "", job: "x" }] })).toThrow(TeamSuggestionError);
  });
});

describe("pickSuggestion", () => {
  const source = suggestionPackage(INPUT);
  const keys = source.package.agents.map((agent) => agent.key);

  it("keeps only the ticked bots and applies the new names", () => {
    const picked = pickSuggestion(source, { keep: [keys[0]!, keys[1]!], names: { [keys[1]!]: "Ledger" } });
    expect(picked.package.agents.map((agent) => agent.name)).toEqual(["Baker Bot", "Ledger"]);
  });

  it("drops a group chat that keeps fewer than two members", () => {
    expect(pickSuggestion(source, { keep: [keys[0]!, keys[1]!] }).package.rooms?.[0]?.members).toHaveLength(2);
    expect(pickSuggestion(source, { keep: [keys[0]!] }).package.rooms).toBeUndefined();
  });

  it("renames the department and keeps the suggested name when the new one is empty", () => {
    expect(pickSuggestion(source, { department: "Corner Bakery" }).package.team?.name).toBe("Corner Bakery");
    expect(pickSuggestion(source, { department: "  " }).package.team?.name).toBe("Bakery");
  });

  it("makes duplicate names distinct and refuses an empty pick", () => {
    const names = pickSuggestion(source, { names: { [keys[0]!]: "Same", [keys[1]!]: "same" } }).package.agents.map((agent) => agent.name);
    expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(names.length);
    expect(() => pickSuggestion(source, { keep: [] })).toThrow(TeamSuggestionError);
  });
});
