import { describe, expect, it } from "vitest";
import { accountDetail, accountName, findNewDuplicate, usesCleanSignIn } from "./connector-account-label";

describe("account names", () => {
  it("prefers the label, then the provider name, then the position, and never the id", () => {
    expect(accountName({ alias: "work", displayName: "octo" }, 0)).toBe("work");
    expect(accountName({ displayName: "octo" }, 0)).toBe("octo");
    expect(accountName({}, 1)).toBe("Account 2");
    expect(accountName({ alias: " " }, 0)).toBe("Account 1");
  });
  it("shows the provider name beside a label that differs", () => {
    expect(accountDetail({ alias: "work", displayName: "octo" })).toBe("octo");
    expect(accountDetail({ alias: "Octo", displayName: "octo" })).toBeUndefined();
    expect(accountDetail({ displayName: "octo" })).toBeUndefined();
    expect(accountDetail({ alias: "work" })).toBeUndefined();
  });
  it("lists only GitHub for the clean window", () => {
    expect(usesCleanSignIn("github")).toBe(true);
    for (const slug of ["gmail", "googlesheets", "outlook", "slack"]) expect(usesCleanSignIn(slug)).toBe(false);
  });
  it("finds a new account that copies an account in the list", () => {
    const accounts = [
      { id: "a", status: "ACTIVE" },
      { id: "b", status: "ACTIVE", duplicateOf: "a" },
      { id: "c", status: "ACTIVE", duplicateOf: "gone" },
    ];
    expect(findNewDuplicate(new Set(["a"]), accounts)?.id).toBe("b");
    expect(findNewDuplicate(new Set(["a", "b"]), accounts)).toBeUndefined();
    expect(findNewDuplicate(new Set(), [{ id: "a", status: "ACTIVE" }])).toBeUndefined();
  });
});
