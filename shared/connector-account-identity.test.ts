import { describe, expect, it } from "vitest";
import { accountDisplayName, accountStateDisplayName, markDuplicateAccounts, revokesProviderGrant } from "./connector-account-identity.ts";

describe("accountDisplayName", () => {
  it("trims a printable name", () => expect(accountDisplayName("  octocat ")).toBe("octocat"));
  it("rejects empty, long, control and non-string values", () => {
    expect(accountDisplayName("   ")).toBeUndefined();
    expect(accountDisplayName("a".repeat(129))).toBeUndefined();
    expect(accountDisplayName("a".repeat(128))).toBe("a".repeat(128));
    expect(accountDisplayName("bad\nname")).toBeUndefined();
    expect(accountDisplayName("bad\u007fname")).toBeUndefined();
    expect(accountDisplayName(42)).toBeUndefined();
    expect(accountDisplayName(undefined)).toBeUndefined();
  });
});

describe("accountStateDisplayName", () => {
  it("reads state.val.displayName leniently", () => {
    expect(accountStateDisplayName({ val: { displayName: " me@example.com " } })).toBe("me@example.com");
    expect(accountStateDisplayName(undefined)).toBeUndefined();
    expect(accountStateDisplayName({ val: "x" })).toBeUndefined();
    expect(accountStateDisplayName({ val: { displayName: 3 } })).toBeUndefined();
  });
});

describe("markDuplicateAccounts", () => {
  it("marks only newer active twins, case-insensitively", () => {
    const marks = markDuplicateAccounts([
      { id: "ca_new", status: "ACTIVE", displayName: "OctoCat", createdAt: "2026-02-01" },
      { id: "ca_old", status: "active", displayName: "octocat", createdAt: "2026-01-01" },
      { id: "ca_other", status: "ACTIVE", displayName: "someone", createdAt: "2026-03-01" },
    ]);
    expect([...marks]).toEqual([["ca_new", "ca_old"]]);
  });
  it("orders by updatedAt, then input order", () => {
    expect([...markDuplicateAccounts([
      { id: "a", status: "ACTIVE", displayName: "x", updatedAt: "2" },
      { id: "b", status: "ACTIVE", displayName: "x", updatedAt: "1" },
    ])]).toEqual([["a", "b"]]);
    expect([...markDuplicateAccounts([
      { id: "a", status: "ACTIVE", displayName: "x" },
      { id: "b", status: "ACTIVE", displayName: "x" },
    ])]).toEqual([["b", "a"]]);
  });
  it("ignores inactive accounts and accounts without a name (older broker)", () => {
    expect(markDuplicateAccounts([
      { id: "a", status: "ACTIVE", displayName: "x" },
      { id: "b", status: "EXPIRED", displayName: "x" },
      { id: "c", status: "ACTIVE" },
      { id: "d", status: "ACTIVE" },
    ]).size).toBe(0);
  });
});

describe("revokesProviderGrant", () => {
  const target = { id: "a", displayName: "x" };
  it("revokes for the only account", () => {
    expect(revokesProviderGrant(target, [])).toBe(true);
    expect(revokesProviderGrant(target, [{ id: "b", status: "EXPIRED", displayName: "x" }])).toBe(true);
    expect(revokesProviderGrant({ id: "a" }, [])).toBe(true);
  });
  it("revokes when every other active account has a different known name", () => {
    expect(revokesProviderGrant(target, [{ id: "b", status: "ACTIVE", displayName: "Y" }])).toBe(true);
  });
  it("keeps the grant for a twin", () => {
    expect(revokesProviderGrant(target, [{ id: "b", status: "active", displayName: "X" }])).toBe(false);
  });
  it("keeps the grant when a name is unknown", () => {
    expect(revokesProviderGrant(target, [{ id: "b", status: "ACTIVE" }])).toBe(false);
    expect(revokesProviderGrant({ id: "a" }, [{ id: "b", status: "ACTIVE", displayName: "y" }])).toBe(false);
  });
});
