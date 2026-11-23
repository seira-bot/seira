import { describe, expect, it, vi } from "vitest";
import { removeNewDuplicate } from "./connector-duplicate";

const before = { connected: true, accounts: [{ id: "a", status: "ACTIVE" }] };

describe("removeNewDuplicate", () => {
  it("removes the new copy once", async () => {
    const remove = vi.fn(async () => ({}));
    const after = { connected: true, accounts: [...before.accounts, { id: "b", status: "ACTIVE", duplicateOf: "a" }] };
    expect(await removeNewDuplicate({ before, after, remove })).toBe(true);
    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("b");
  });
  it("keeps a different account and an old server's answer", async () => {
    const remove = vi.fn(async () => ({}));
    const other = { connected: true, accounts: [...before.accounts, { id: "b", status: "ACTIVE" }] };
    expect(await removeNewDuplicate({ before, after: other, remove })).toBe(false);
    expect(await removeNewDuplicate({ before, after: undefined, remove })).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });
});
