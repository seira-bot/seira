import { describe, expect, it } from "vitest";
import { claudeRootRefusal, refuseRootFullAccess, ROOT_FULL_ACCESS_TEXT, runsAsRoot, startsWithAsk } from "./run-as-root.ts";
import { userErrorFields } from "./user-errors.ts";

describe("runsAsRoot", () => {
  it.each([[0, true], [1000, false], [undefined, false]])("euid %s gives %s", (euid, expected) => {
    expect(runsAsRoot(euid)).toBe(expected);
  });
});

describe("startsWithAsk", () => {
  it.each([[false, 0, true], [true, 1000, true], [false, 1000, false], [false, undefined, false]] as const)("hosted %s, euid %s gives %s", (hosted, euid, expected) => {
    expect(startsWithAsk(hosted, euid)).toBe(expected);
  });
});

describe("claudeRootRefusal", () => {
  it("matches the refusal Claude Code prints", () => {
    expect(claudeRootRefusal("--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons")).toBe(true);
  });
  it("ignores other failures", () => {
    expect(claudeRootRefusal("claude exited 1 before result: network error")).toBe(false);
    expect(claudeRootRefusal("")).toBe(false);
  });
});

describe("refuseRootFullAccess", () => {
  it("throws a coded error for Full access as root", () => {
    let thrown: unknown;
    try { refuseRootFullAccess("bypassPermissions", 0); } catch (error) { thrown = error; }
    expect((thrown as Error).message).toBe(ROOT_FULL_ACCESS_TEXT);
    expect(userErrorFields(thrown).errorKey).toBe("serverError.engine.rootFullAccess");
  });
  it.each([["auto", 0], ["default", 0], ["acceptEdits", 0], [undefined, 0], ["bypassPermissions", 1000], ["bypassPermissions", undefined]] as const)("passes %s for euid %s", (mode, euid) => {
    expect(refuseRootFullAccess(mode, euid)).toBe(mode);
  });
});
