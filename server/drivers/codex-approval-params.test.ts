import { describe, expect, it } from "vitest";

import { namedApprovalParams, withFolderGrants } from "./codex-approval-params.ts";

const grants = [{ path: "/data/ro", write: false }, { path: "/data/rw", write: true }, { path: "/data/rw2", write: true }];

describe("withFolderGrants", () => {
  it("returns the same params for no folders, no can-change grant, or full access", () => {
    const ask = namedApprovalParams("ask");
    expect(withFolderGrants(ask, undefined)).toBe(ask);
    expect(withFolderGrants(ask, { limited: true, grants: [grants[0]] })).toBe(ask);
    const full = namedApprovalParams("full");
    expect(withFolderGrants(full, { limited: true, grants })).toBe(full);
  });

  it("adds only can-change grants to the roots and keeps existing roots without a duplicate", () => {
    const base = namedApprovalParams("ask");
    const params = { ...base, turn: { ...base.turn, sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/x", "/data/rw"] } } };
    expect(withFolderGrants(params, { limited: false, grants }).turn.sandboxPolicy).toEqual({ type: "workspaceWrite", writableRoots: ["/x", "/data/rw", "/data/rw2"] });
  });

  it("does not change a read-only sandbox", () => {
    const base = namedApprovalParams("ask");
    const params = { ...base, turn: { ...base.turn, sandboxPolicy: { type: "readOnly" } } };
    expect(withFolderGrants(params, { limited: true, grants })).toBe(params);
  });
});
