import { describe, expect, it } from "vitest";

import { canConnect, isConnectionOwner, LOCAL_OWNER_KEY, requesterKey, requesterLabel } from "./owner.ts";
import { personKey } from "../person-key.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { SessionRecord } from "../sessions.ts";

const session = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "s1", tokenHash: "a".repeat(64), label: "x", scopes: ["admin", "client"], createdAt: 0, lastSeenAt: 0, expiresAt: 1, ...over,
});
const sessionAuth = (over: Partial<SessionRecord> = {}): RequestAuth => ({ kind: "session", session: session(over), via: "bearer", scopes: over.scopes ?? ["admin", "client"] });
const desktop: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const service: RequestAuth = { kind: "loopback", scopes: ["client"], trust: "service" };

describe("github owner", () => {
  it("keys a signed-in person by email and the desktop owner as local", () => {
    expect(requesterKey(sessionAuth({ email: "ana@shop.example" }))).toBe(personKey({ id: "", email: "ana@shop.example" }));
    expect(requesterKey(desktop)).toBe(LOCAL_OWNER_KEY);
    expect(requesterKey(sessionAuth())).toBe(LOCAL_OWNER_KEY);
  });

  it("gives no key to a service caller or a client-only session", () => {
    expect(requesterKey(service)).toBeNull();
    expect(requesterKey(sessionAuth({ scopes: ["client"] }))).toBeNull();
  });

  it("labels by email local part, profile name, or a plain fallback", () => {
    expect(requesterLabel(sessionAuth({ email: "ana@shop.example" }))).toBe("ana");
    expect(requesterLabel(desktop, "Rama")).toBe("Rama");
    expect(requesterLabel(desktop)).toBe("the owner");
  });

  it("lets anyone with owner or admin rights connect while no one owns it", () => {
    expect(canConnect(desktop, {})).toBe(true);
    expect(canConnect(sessionAuth({ email: "ana@shop.example" }), {})).toBe(true);
    expect(canConnect(service, {})).toBe(false);
    expect(canConnect(sessionAuth({ scopes: ["client"], email: "g@x.example" }), {})).toBe(false);
  });

  it("limits an owned connection to its owner", () => {
    const ana = sessionAuth({ email: "ana@shop.example" });
    const store = { ownerKey: requesterKey(ana)! };
    expect(isConnectionOwner(ana, store)).toBe(true);
    expect(canConnect(ana, store)).toBe(true);
    const bob = sessionAuth({ id: "s2", email: "bob@shop.example" });
    expect(isConnectionOwner(bob, store)).toBe(false);
    expect(canConnect(bob, store)).toBe(false);
    expect(canConnect(desktop, store)).toBe(false);
  });

  it("does not let a client-only session of the owner count as the owner", () => {
    const store = { ownerKey: personKey({ id: "", email: "ana@shop.example" }) };
    expect(isConnectionOwner(sessionAuth({ email: "ana@shop.example", scopes: ["client"] }), store)).toBe(false);
  });
});
