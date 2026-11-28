import { describe, expect, it } from "vitest";
import { inviteAddsToBot, mayInviteHere, type InviteEnvironment } from "./invite-access";

const selfHosted: InviteEnvironment = { emailSignIn: true, cloudTeam: false };
const ready = { admin: true as boolean | null, here: false, config: {} as unknown, environment: selfHosted as InviteEnvironment | null };

describe("where an admin may invite people", () => {
  it("AC-23 allows an admin of a self-hosted server that signs in by email", () => {
    expect(mayInviteHere(ready)).toBe(true);
    expect(mayInviteHere({ ...ready, config: { membership: { authority: "local" } } })).toBe(true);
  });

  it("AC-23 refuses everyone who is not an admin, and while that is unknown", () => {
    expect(mayInviteHere({ ...ready, admin: false })).toBe(false);
    expect(mayInviteHere({ ...ready, admin: null })).toBe(false);
  });

  it("AC-E3 refuses the desktop app's own computer page", () => {
    expect(mayInviteHere({ ...ready, here: true })).toBe(false);
  });

  it("AC-E2 allows a connected server's page in the desktop window", () => {
    expect(mayInviteHere({ ...ready, here: false })).toBe(true);
  });

  it("AC-23 refuses a Team Cloud, by its settings or by what the server says", () => {
    expect(mayInviteHere({ ...ready, config: { team: { id: "acme" } } })).toBe(false);
    expect(mayInviteHere({ ...ready, environment: { emailSignIn: true, cloudTeam: true } })).toBe(false);
  });

  it("AC-23 refuses a My Cloud home", () => {
    expect(mayInviteHere({ ...ready, config: { cloudHome: true } })).toBe(false);
  });

  it("AC-23 refuses a hosted workspace whose people are managed elsewhere", () => {
    expect(mayInviteHere({ ...ready, config: { membership: { authority: "portal" } } })).toBe(false);
  });

  it("AC-23 refuses a server without email sign-in, and while the server has not answered", () => {
    expect(mayInviteHere({ ...ready, environment: { emailSignIn: false, cloudTeam: false } })).toBe(false);
    expect(mayInviteHere({ ...ready, environment: null })).toBe(false);
    expect(mayInviteHere({ ...ready, config: null })).toBe(false);
  });
});

describe("which bots an invite adds the person to", () => {
  it("needs no note for a bot shared with everyone", () => {
    expect(inviteAddsToBot({}, "ada@acme.test")).toBe(false);
    expect(inviteAddsToBot({ visibility: null }, "ada@acme.test")).toBe(false);
    expect(inviteAddsToBot({ visibility: "everyone" }, "ada@acme.test")).toBe(false);
  });

  it("needs the note for a bot shared with admins or with other people", () => {
    expect(inviteAddsToBot({ visibility: "admins" }, "ada@acme.test")).toBe(true);
    expect(inviteAddsToBot({ visibility: { people: ["ana@acme.test"] } }, "ada@acme.test")).toBe(true);
    expect(inviteAddsToBot({ onlyPeopleAdded: true }, "ada@acme.test")).toBe(true);
  });

  it("needs no note when the entry is already one of the people, ignoring case and spaces", () => {
    expect(inviteAddsToBot({ visibility: { people: ["ada@acme.test"] } }, " Ada@Acme.test ")).toBe(false);
    expect(inviteAddsToBot({ visibility: { people: ["Ada@Acme.test "] } }, "ada@acme.test")).toBe(false);
  });

  it("needs no note for an address under a domain that is already one of the people, but does for another domain", () => {
    expect(inviteAddsToBot({ visibility: { people: ["@acme.test"] } }, "ada@acme.test")).toBe(false);
    expect(inviteAddsToBot({ visibility: { people: ["@acme.test"] } }, "@acme.test")).toBe(false);
    expect(inviteAddsToBot({ visibility: { people: ["@acme.test"] } }, "ada@other.test")).toBe(true);
    expect(inviteAddsToBot({ visibility: { people: ["@acme.test"] } }, "@sub.acme.test")).toBe(true);
  });
});
