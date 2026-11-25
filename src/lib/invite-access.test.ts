import { describe, expect, it } from "vitest";
import { mayInviteHere, type InviteEnvironment } from "./invite-access";

const selfHosted: InviteEnvironment = { emailSignIn: true, cloudTeam: false };
const ready = { admin: true as boolean | null, desktop: false, config: {} as unknown, environment: selfHosted as InviteEnvironment | null };

describe("where an admin may invite people", () => {
  it("AC-23 allows an admin of a self-hosted server that signs in by email", () => {
    expect(mayInviteHere(ready)).toBe(true);
    expect(mayInviteHere({ ...ready, config: { membership: { authority: "local" } } })).toBe(true);
  });

  it("AC-23 refuses everyone who is not an admin, and while that is unknown", () => {
    expect(mayInviteHere({ ...ready, admin: false })).toBe(false);
    expect(mayInviteHere({ ...ready, admin: null })).toBe(false);
  });

  it("AC-23 refuses the desktop app", () => {
    expect(mayInviteHere({ ...ready, desktop: true })).toBe(false);
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
