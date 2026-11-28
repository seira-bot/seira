import { describe, expect, it } from "vitest";
import type { RequestAuth } from "../request-auth.ts";
import type { SessionRecord } from "../sessions.ts";
import type { TodoRecord } from "../todos.ts";
import { createTodoReads } from "./todo-reads.ts";

const NOBODY = "p_nobody";
const OUTSIDE = "p_outside";
const OWNER = "p_owner";
const PAT = "p_pat";

function session(id: string, admin = false): RequestAuth {
  return { kind: "session", session: { id, email: `${id}@example.com` } as SessionRecord, via: "cookie", scopes: admin ? ["client", "admin"] : ["client"] };
}
const LOOPBACK: RequestAuth = { kind: "loopback", scopes: ["client"] };

function reads(personal: boolean, world: { guest?: string[]; outside?: string[]; opener?: Record<string, string> } = {}) {
  return createTodoReads({
    personal, nobodyKey: NOBODY, outsideKey: OUTSIDE,
    actorKey: (auth) => (auth.scopes.includes("admin") ? OWNER : `p_${auth.session.id}`),
    ownerSession: (auth) => auth.kind === "session" && auth.scopes.includes("admin"),
    guestDriven: (threadId) => (world.guest ?? []).includes(threadId),
    outsideDriven: (threadId) => (world.outside ?? []).includes(threadId),
    openerFrom: (threadId) => world.opener?.[threadId],
  });
}

const todo = (over: Partial<TodoRecord> = {}) => over as TodoRecord;

describe("todo reads on a personal Cloud: people (security)", () => {
  it("shows a guest only the todos they work for, and the owner every todo", () => {
    const rules = reads(true);
    expect(rules.sessionMayRead(session("pat"), todo({ person: { key: PAT } }))).toBe(true);
    expect(rules.sessionMayRead(session("pat"), todo({ person: { key: OWNER } }))).toBe(false);
    expect(rules.sessionMayRead(session("pat"), todo({ person: { key: "p_sam" } }))).toBe(false);
    expect(rules.sessionMayRead(session("pat"), todo())).toBe(false);
    expect(rules.sessionMayRead(session("owner", true), todo({ person: { key: PAT } }))).toBe(true);
    expect(rules.sessionMayRead(session("owner", true), todo())).toBe(true);
  });

  it("lets the machine itself read every todo, as with every other read", () => {
    expect(reads(true).sessionMayRead(LOOPBACK, todo({ person: { key: OWNER } }))).toBe(true);
  });

  it("changes nothing on a Team Cloud or a desktop, which read by the audience rule", () => {
    expect(reads(false).sessionMayRead(session("pat"), todo({ person: { key: OWNER } }))).toBe(true);
  });
});

describe("todo reads on a personal Cloud: confined turns (security)", () => {
  const world = { guest: ["guest-chat"], outside: ["mail", "other-mail"], opener: { "guest-chat": PAT, mail: OUTSIDE, "other-mail": OUTSIDE } };

  it("lets a guest's turn read only its own conversation's todos and its person's", () => {
    const rules = reads(true, world);
    expect(rules.turnMayRead("guest-chat", todo({ person: { key: PAT } }))).toBe(true);
    expect(rules.turnMayRead("guest-chat", todo({ person: { key: OWNER } }))).toBe(false);
    expect(rules.turnMayRead("guest-chat", todo())).toBe(false);
    expect(rules.turnMayRead("guest-chat", todo({ person: { key: OWNER }, source: { threadId: "guest-chat", quote: "q" } }))).toBe(true);
    expect(rules.turnMayRead("guest-chat", todo({ person: { key: OWNER }, threadId: "guest-chat" }))).toBe(true);
  });

  it("never lets outside work read the owner's todos or another outside work's by the shared marker key", () => {
    const rules = reads(true, world);
    expect(rules.turnMayRead("mail", todo({ person: { key: OWNER } }))).toBe(false);
    expect(rules.turnMayRead("mail", todo({ person: { key: OUTSIDE }, source: { threadId: "other-mail", quote: "q" } }))).toBe(false);
    expect(rules.turnMayRead("other-mail", todo({ person: { key: OUTSIDE }, source: { threadId: "other-mail", quote: "q" } }))).toBe(true);
  });

  it("treats a nobody opener as no person", () => {
    const rules = reads(true, { guest: ["guest-chat"], opener: { "guest-chat": NOBODY } });
    expect(rules.turnMayRead("guest-chat", todo({ person: { key: NOBODY } }))).toBe(false);
  });

  it("leaves an owner's turn, a Team Cloud and a desktop to their own rules", () => {
    expect(reads(true, world).turnMayRead("owner-chat", todo({ person: { key: PAT } }))).toBe(true);
    expect(reads(false, world).turnMayRead("mail", todo({ person: { key: OWNER } }))).toBe(true);
  });
});
