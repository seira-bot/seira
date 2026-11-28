import { describe, expect, it } from "vitest";
import type { Audience } from "../audience.ts";
import type { Viewer } from "../bot-visibility.ts";
import { personKey } from "../person-key.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { SessionRecord } from "../sessions.ts";
import type { TodoRecord } from "../todos.ts";
import { createTodoPolicy, type TodoPolicyDeps } from "./todo-policy.ts";

const NOBODY = "p_nobody";
const OUTSIDE = "p_outside";
const OWNER = "p_owner";
const PAT_EMAIL = "pat@example.com";
const PAT = personKey({ id: "", email: PAT_EMAIL });
const SAM = personKey({ id: "", email: "sam@example.com" });

function session(email: string, admin = false): RequestAuth {
  return { kind: "session", session: { id: `s-${email}`, email } as SessionRecord, via: "cookie", scopes: admin ? ["client", "admin"] : ["client"] };
}
const LOOPBACK: RequestAuth = { kind: "loopback", scopes: ["client"] };

function todo(over: Partial<TodoRecord> = {}): TodoRecord {
  return { id: "t", title: "Write notes", status: "open", start: { kind: "free" }, rank: 1, madeBy: { kind: "person", name: "Pat" }, attempts: 0, depth: 0, createdAt: 1, updatedAt: 1, ...over };
}

interface World {
  audiences?: Record<string, Audience>;
  unreadable?: Array<[string, string]>;
  guest?: string[];
  outside?: string[];
  staysHere?: string[];
  opener?: Record<string, string>;
  levels?: (viewer: Viewer, botId: string) => string;
}

function policy(mode: TodoPolicyDeps["mode"], world: World = {}) {
  return createTodoPolicy({
    mode, nobodyKey: NOBODY, outsideKey: OUTSIDE,
    actorKey: (auth) => (auth.scopes.includes("admin") && mode === "personal" ? OWNER : personKey(auth.session)),
    ownerSession: (auth) => auth.kind === "session" && auth.scopes.includes("admin"),
    ownerPerson: (key) => key === OWNER,
    viewerFor: (auth) => (auth.kind === "session" ? { kind: auth.scopes.includes("admin") ? "all" : "member", email: auth.session.email } : { kind: "all" }),
    level: (viewer, botId) => (world.levels?.(viewer, botId) ?? (viewer.kind === "all" ? "chat" : "view")) as never,
    teamPeople: () => [{ email: PAT_EMAIL, role: "member" }, { email: "ada@example.com", role: "admin" }],
    signedIn: () => [{ id: "s-guest", email: PAT_EMAIL }],
    audienceOf: (threadId) => world.audiences?.[threadId] ?? "team",
    readableFrom: (threadId) => (other) => !(world.unreadable ?? []).some(([from, to]) => from === threadId && to === other),
    guestDriven: (threadId) => (world.guest ?? []).includes(threadId),
    outsideDriven: (threadId) => (world.outside ?? []).includes(threadId),
    outsideStaysHere: (threadId) => (world.staysHere ?? []).includes(threadId),
    openerFrom: (threadId) => world.opener?.[threadId],
  });
}

describe("todo policy: who may change a todo (security)", () => {
  it("lets a guest change only their own todo on a personal Cloud, and the owner every todo", () => {
    const rules = policy("personal");
    const owners = todo({ person: { key: OWNER } });
    const pats = todo({ person: { key: PAT } });
    expect(rules.changeRefusal(session(PAT_EMAIL), owners)).toContain("only change todos you made");
    expect(rules.changeRefusal(session(PAT_EMAIL), todo())).toContain("only change todos you made");
    expect(rules.changeRefusal(session(PAT_EMAIL), pats)).toBeNull();
    expect(rules.changeRefusal(session("owner@example.com", true), pats)).toBeNull();
    expect(rules.changeRefusal(LOOPBACK, pats)).toContain("only change todos you made");
  });

  it("lets a Team Cloud member change a team todo but not another person's own", () => {
    const rules = policy("team");
    expect(rules.changeRefusal(session("sam@example.com"), todo({ person: { key: NOBODY } }))).toBeNull();
    expect(rules.changeRefusal(session("sam@example.com"), todo())).toBeNull();
    expect(rules.changeRefusal(session("sam@example.com"), todo({ person: { key: PAT } }))).toContain("only change todos you made");
    expect(rules.changeRefusal(session(PAT_EMAIL), todo({ person: { key: PAT } }))).toBeNull();
  });

  it("refuses nothing on a desktop", () => {
    expect(policy("desktop").changeRefusal(LOOPBACK, todo({ person: { key: PAT } }))).toBeNull();
  });
});

describe("todo policy: whom a todo works for", () => {
  it("records the person who wrote it, and nobody for a bot's shell on a Cloud", () => {
    expect(policy("personal").personOf(session(PAT_EMAIL))).toEqual({ key: PAT, viewer: { kind: "member", email: PAT_EMAIL } });
    expect(policy("personal").personOf(LOOPBACK)).toEqual({ key: NOBODY, viewer: { kind: "member" } });
    expect(policy("desktop").personOf(LOOPBACK)).toEqual({ viewer: { kind: "all" } });
  });

  it("reads a person's level by their Team Cloud role, and an unrecorded person as an anonymous member", () => {
    const seen: Viewer[] = [];
    const rules = policy("team", { levels: (viewer) => { seen.push(viewer); return "chat"; } });
    rules.levelFor({ viewer: { kind: "member", email: "ada@example.com" } }, "atlas");
    rules.levelFor({ viewer: { kind: "all", email: PAT_EMAIL } }, "atlas");
    rules.levelFor(undefined, "atlas");
    expect(seen).toEqual([{ kind: "all", email: "ada@example.com" }, { kind: "member", email: PAT_EMAIL }, { kind: "member" }]);
  });

  it("names the person of a conversation key, and no person for a marker or off a Cloud", () => {
    const team = policy("team");
    expect(team.viewerOf(PAT)).toEqual({ kind: "member", email: PAT_EMAIL });
    expect(team.viewerOf(SAM)).toEqual({ kind: "member" });
    expect(team.viewerOf(OWNER)).toEqual({ kind: "all" });
    expect(team.viewerOf(NOBODY)).toBeUndefined();
    expect(team.viewerOf(OUTSIDE)).toBeUndefined();
    expect(team.viewerOf(undefined)).toBeUndefined();
    expect(policy("personal").viewerOf(PAT)).toEqual({ kind: "member", email: PAT_EMAIL });
    expect(policy("desktop").viewerOf(PAT)).toBeUndefined();
  });

  it("gives a bot's todo the person of a one-person conversation, and outside work the outside key with no person", () => {
    const rules = policy("personal", { opener: { guest: PAT, outside: OUTSIDE }, guest: ["guest"], outside: ["outside"] });
    expect(rules.botPerson("guest")).toEqual({ key: PAT, viewer: { kind: "member", email: PAT_EMAIL } });
    expect(rules.botPerson("outside")).toEqual({ key: OUTSIDE });
    expect(policy("team", { opener: { shared: NOBODY } }).botPerson("shared")).toEqual({ key: NOBODY });
  });

  it("opens a todo with no person as nobody on a Cloud, so it is confined", () => {
    expect(policy("personal").openKey(todo())).toBe(NOBODY);
    expect(policy("desktop").openKey(todo())).toBeUndefined();
    expect(policy("team").openKey(todo({ person: { key: PAT } }))).toBe(PAT);
  });
});

describe("todo policy: who may read a todo on a Team Cloud (security)", () => {
  const world: World = { audiences: { "pat-chat": `member:${PAT}`, room: "room:r1", main: "team" } };

  it("keeps a person's own todo to that person, whatever their role", () => {
    const rules = policy("team", world);
    const pats = todo({ person: { key: PAT } });
    expect(rules.audience(pats)).toBe(`member:${PAT}`);
    expect(rules.sessionMayRead(session(PAT_EMAIL), pats)).toBe(true);
    expect(rules.sessionMayRead(session("sam@example.com"), pats)).toBe(false);
    expect(rules.sessionMayRead(session("ada@example.com", true), pats)).toBe(false);
    expect(rules.sessionMayRead(session("sam@example.com"), todo({ person: { key: NOBODY } }))).toBe(true);
    expect(rules.sessionMayRead(session("sam@example.com"), todo())).toBe(true);
  });

  it("gives a bot's todo the audience of the conversation it came from", () => {
    const rules = policy("team", world);
    expect(rules.audience(todo({ madeBy: { kind: "bot", botId: "atlas" } as never, source: { threadId: "room", quote: "q" } }))).toBe("room:r1");
  });

  it("lets a turn read a todo only by the audience rule and only from conversations it may read", () => {
    const rules = policy("team", { ...world, unreadable: [["main", "secret"]] });
    const pats = todo({ person: { key: PAT } });
    expect(rules.turnMayRead("pat-chat", pats)).toBe(true);
    expect(rules.turnMayRead("main", pats)).toBe(false);
    expect(rules.turnMayRead("room", pats)).toBe(false);
    expect(rules.turnMayRead("main", todo())).toBe(true);
    expect(rules.turnMayRead("main", todo({ threadId: "secret" }))).toBe(false);
  });

  it("lets the picker read only the team's todos", () => {
    const rules = policy("team", { ...world, unreadable: [["picker", "secret"]] });
    expect(rules.pickerMayRead("picker", todo())).toBe(true);
    expect(rules.pickerMayRead("picker", todo({ person: { key: PAT } }))).toBe(false);
    expect(rules.pickerMayRead(undefined, todo({ person: { key: PAT } }))).toBe(false);
    expect(rules.pickerMayRead("picker", todo({ source: { threadId: "secret", quote: "q" } }))).toBe(false);
    expect(rules.pickerMayRead(undefined, todo({ source: { threadId: "main", quote: "q" } }))).toBe(false);
    expect(rules.pickerMayRead("picker", todo({ madeBy: { kind: "bot", botId: "atlas" } as never, source: { threadId: "room", quote: "q" } }))).toBe(false);
  });

  it("refuses a bot todo from a room or a shared conversation, and parks one that would run wider", () => {
    const rules = policy("team", { ...world, opener: { "pat-chat": PAT, room: NOBODY, main: NOBODY } });
    expect(rules.addRefusal("room")).toContain("more people can read it");
    expect(rules.addRefusal("pat-chat")).toBeNull();
    expect(rules.addRefusal("main")).toBeNull();
    const fromRoom = todo({ madeBy: { kind: "bot", botId: "atlas" } as never, source: { threadId: "room", quote: "q" }, person: { key: NOBODY } });
    expect(rules.mayRun(fromRoom)).toBe(false);
    expect(rules.mayRun(todo({ madeBy: { kind: "bot", botId: "atlas" } as never, source: { threadId: "pat-chat", quote: "q" }, person: { key: PAT } }))).toBe(true);
    expect(rules.mayRun(todo({ person: { key: PAT } }))).toBe(true);
    expect(rules.mayRun(todo())).toBe(true);
    expect(policy("personal").mayRun(fromRoom)).toBe(true);
  });
});

describe("todo policy: who may read a todo on a personal Cloud (security)", () => {
  it("shows a guest only their own todos, and the owner every todo", () => {
    const rules = policy("personal");
    const pats = todo({ person: { key: PAT } });
    const owners = todo({ person: { key: OWNER } });
    expect(rules.sessionMayRead(session(PAT_EMAIL), pats)).toBe(true);
    expect(rules.sessionMayRead(session(PAT_EMAIL), owners)).toBe(false);
    expect(rules.sessionMayRead(session(PAT_EMAIL), todo())).toBe(false);
    expect(rules.sessionMayRead(session("owner@example.com", true), pats)).toBe(true);
    expect(rules.sessionMayRead(LOOPBACK, pats)).toBe(false);
    expect(policy("desktop").sessionMayRead(LOOPBACK, pats)).toBe(true);
  });

  it("lets a confined turn read only its own conversation's todos and its person's", () => {
    const rules = policy("personal", { guest: ["guest"], outside: ["mail", "other-mail"], opener: { guest: PAT, mail: OUTSIDE, "other-mail": OUTSIDE } });
    expect(rules.turnMayRead("guest", todo({ person: { key: PAT } }))).toBe(true);
    expect(rules.turnMayRead("guest", todo({ person: { key: OWNER } }))).toBe(false);
    expect(rules.turnMayRead("guest", todo({ person: { key: OWNER }, source: { threadId: "guest", quote: "q" } }))).toBe(true);
    expect(rules.turnMayRead("guest", todo({ person: { key: OWNER }, threadId: "guest" }))).toBe(true);
    expect(rules.turnMayRead("owner-chat", todo({ person: { key: PAT } }))).toBe(true);
  });

  it("never lets outside work read another outside work's todos by the shared marker key", () => {
    const rules = policy("personal", { outside: ["mail", "other-mail"], opener: { mail: OUTSIDE, "other-mail": OUTSIDE } });
    const otherMail = todo({ person: { key: OUTSIDE }, source: { threadId: "other-mail", quote: "q" } });
    expect(rules.turnMayRead("mail", otherMail)).toBe(false);
    expect(rules.turnMayRead("other-mail", otherMail)).toBe(true);
  });

  it("keeps outside work in its own conversation", () => {
    const rules = policy("personal", { staysHere: ["mail"] });
    expect(rules.addRefusal("mail")).toContain("cannot add todos");
    expect(rules.keyFrom("mail")).toBe(OUTSIDE);
    expect(rules.addRefusal("owner-chat")).toBeNull();
  });

  it("lets the picker read only the owner's todos, never a guest's or outside work's", () => {
    const rules = policy("personal");
    expect(rules.pickerMayRead("picker", todo({ person: { key: OWNER } }))).toBe(true);
    expect(rules.pickerMayRead("picker", todo({ person: { viewer: { kind: "all" } } }))).toBe(true);
    expect(rules.pickerMayRead("picker", todo({ person: { key: PAT } }))).toBe(false);
    expect(rules.pickerMayRead("picker", todo({ person: { key: OUTSIDE } }))).toBe(false);
    expect(rules.pickerMayRead("picker", todo())).toBe(false);
    expect(policy("desktop").pickerMayRead("picker", todo())).toBe(true);
  });
});
