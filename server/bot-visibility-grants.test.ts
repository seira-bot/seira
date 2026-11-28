import { describe, expect, it } from "vitest";

import { memberBot, VisibleSet, type ResolvedGrant, type Viewer } from "./bot-visibility.ts";

const ADA: Viewer = { kind: "member", email: "ada@acme.test" };

const bots = [
  { id: "sales", threadId: "t-sales", section: "Sales" },
  { id: "sales-2", threadId: "t-sales-2", section: "Sales" },
  { id: "fin", threadId: "t-fin", section: "Finance" },
  { id: "fin-2", threadId: "t-fin-2", section: "Finance" },
  { id: "closed", threadId: "t-closed", section: "Finance", visibility: "admins" as const },
  { id: "chief", threadId: "t-chief" },
];
const groups = [
  { id: "room-fin", threadId: "t-room-fin", memberIds: ["fin", "fin-2"], section: "Finance" },
  { id: "room-sales", threadId: "t-room-sales", memberIds: ["sales"], section: "Sales" },
  { id: "room-mixed", threadId: "t-room-mixed", memberIds: ["sales", "fin"], section: "Sales" },
  { id: "room-other", threadId: "t-room-other", memberIds: ["fin", "fin-2"], section: "Legal" },
  { id: "dm-fin", threadId: "t-dm-fin", memberIds: ["fin"], dm: true },
];

type Items = Record<string, "view" | "chat">;
const grantOf = (departments: Items, botItems: Items = {}): ResolvedGrant => ({ departments: new Map(Object.entries(departments)), bots: new Map(Object.entries(botItems)) });
const seenBy = (grant: ResolvedGrant) => {
  const visible = new VisibleSet(bots, groups, ADA, undefined, undefined, grant);
  return { visible, ids: bots.filter((bot) => visible.bot(bot.id)).map((bot) => bot.id) };
};

describe("a member with a bot grant", () => {
  it("sees a bot only when its department or its id is in the grant (AC-04)", () => {
    expect(seenBy(grantOf({}, { fin: "chat" })).ids).toEqual(["fin"]);
    expect(seenBy(grantOf({ Sales: "chat" }, { fin: "chat" })).ids).toEqual(["sales", "sales-2", "fin"]);
    expect(seenBy(grantOf({ Finance: "view" })).ids).toEqual(["fin", "fin-2"]);
    expect(seenBy(grantOf({}, { chief: "chat" })).ids).toEqual(["chief"]);
  });

  it("does not see a granted bot whose audience refuses them (AC-05)", () => {
    const { ids, visible } = seenBy(grantOf({ Finance: "chat" }, { closed: "chat" }));
    expect(ids).toEqual(["fin", "fin-2"]);
    expect(visible.level("closed")).toBe("none");
    const listed = new VisibleSet(bots.map((bot) => (bot.id === "closed" ? { ...bot, visibility: { people: ["ada@acme.test"] } } : bot)), groups, ADA, undefined, undefined, grantOf({}, { closed: "chat" }));
    expect(listed.bot("closed")).toBe(true);
  });

  it("gives the level of the grant, and the higher one when a department and the bot both name it (AC-09)", () => {
    const { visible } = seenBy(grantOf({ Finance: "view", Sales: "chat" }, { fin: "chat", sales: "view", chief: "view" }));
    expect(visible.level("fin")).toBe("chat");
    expect(visible.level("fin-2")).toBe("view");
    expect(visible.level("sales")).toBe("chat");
    expect(visible.level("sales-2")).toBe("chat");
    expect(visible.level("chief")).toBe("view");
    expect(visible.level("closed")).toBe("none");
  });

  it("is leveled only when some item says view, and never gives edit", () => {
    expect(seenBy(grantOf({ Sales: "chat" }, { fin: "chat" })).visible.leveled).toBe(false);
    expect(seenBy(grantOf({ Sales: "chat" }, { fin: "view" })).visible.leveled).toBe(true);
    expect(seenBy(grantOf({ Sales: "view" })).visible.leveled).toBe(true);
    expect(new VisibleSet(bots, groups, ADA).leveled).toBe(false);
    expect(new VisibleSet(bots, groups, ADA, undefined, { of: () => undefined, person: null }).leveled).toBe(true);
    const { visible } = seenBy(grantOf({ Sales: "chat" }, { fin: "chat" }));
    expect(bots.every((bot) => visible.level(bot.id) !== "edit")).toBe(true);
  });

  it("sees a room when its department is granted, or every bot in it is granted by id", () => {
    const rooms = (grant: ResolvedGrant) => { const { visible } = seenBy(grant); return groups.filter((group) => visible.group(group.id)).map((group) => group.id); };
    expect(rooms(grantOf({ Finance: "chat" }))).toEqual(["room-fin", "dm-fin"]);
    expect(rooms(grantOf({}, { fin: "chat", "fin-2": "view" }))).toEqual(["room-fin", "room-other", "dm-fin"]);
    expect(rooms(grantOf({}, { fin: "chat" }))).toEqual(["dm-fin"]);
    expect(rooms(grantOf({ Sales: "chat" }, { fin: "chat" }))).toEqual(["room-sales", "room-mixed", "dm-fin"]);
    expect(rooms(grantOf({ Sales: "chat" }, { "fin-2": "chat" }))).toEqual(["room-sales"]);
  });

  it("lists the granted departments and the departments of the bots it sees", () => {
    const { visible } = seenBy(grantOf({ Sales: "chat" }, { fin: "view", closed: "chat" }));
    expect(visible.sections(["Sales", "Finance", "Legal"])).toEqual(["Sales", "Finance"]);
    expect(visible.departmentAllowed("Finance")).toBe(true);
    expect(visible.departmentAllowed("Legal")).toBe(false);
    expect(visible.limitedToDepartments).toBe(true);
    expect(seenBy(grantOf({}, {})).visible.sections(["Sales"])).toEqual([]);
  });

  it("tells a view grant its level on the bot, without the audience or the access list (AC-08)", () => {
    const { visible } = seenBy(grantOf({ Sales: "chat" }, { closed: "view", fin: "view" }));
    const stored = { id: "fin", threadId: "t-fin", section: "Finance", visibility: { people: ["ada@acme.test"] }, access: { everyone: "none", people: {} } };
    expect(memberBot(stored, visible)).toEqual({ id: "fin", threadId: "t-fin", section: "Finance", yourAccess: "view" });
    expect(memberBot({ id: "sales", threadId: "t-sales", section: "Sales" }, visible)).toMatchObject({ yourAccess: "chat" });
  });

  it("sends no level to a member whose grant has no view item", () => {
    const { visible } = seenBy(grantOf({ Sales: "chat" }));
    expect(memberBot({ id: "sales", threadId: "t-sales", section: "Sales" }, visible)).not.toHaveProperty("yourAccess");
  });
});
