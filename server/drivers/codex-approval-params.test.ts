import { describe, expect, it } from "vitest";

import { namedApprovalParams, withFolderGrants } from "./codex-approval-params.ts";

const grants = [{ path: "/data/ro", write: false }, { path: "/data/rw", write: true }, { path: "/data/rw2", write: true }];

describe("withFolderGrants", () => {
  it("returns the same params for no folders, no can-change grant, or full access", () => {
    const ask = namedApprovalParams("ask");
    expect(withFolderGrants(ask, undefined)).toBe(ask);
    expect(withFolderGrants(ask, { limited: true, grants: [grants[0]] })).toBe(ask);
    const full = namedApprovalParams("full");
    expect(withFolderGrants(full, { limited: false, grants })).toBe(full);
    expect(namedApprovalParams("full", { limited: false, grants })).toEqual(full);
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

describe("a limited full turn", () => {
  it("is workspace-write with network access and never asks", () => {
    const params = namedApprovalParams("full", { limited: true, grants });
    expect(params.thread).toMatchObject({ approvalPolicy: "never", sandbox: "workspace-write" });
    expect(withFolderGrants(params, { limited: true, grants }, "/work").turn).toMatchObject({
      approvalPolicy: "never",
      sandboxPolicy: { type: "workspaceWrite", networkAccess: true, writableRoots: ["/work", "/data/rw", "/data/rw2"] },
    });
  });

  it("keeps network access when the resolved sandbox says otherwise", () => {
    const base = namedApprovalParams("full", { limited: true, grants: [] });
    const resolved = { ...base, turn: { ...base.turn, sandboxPolicy: { type: "workspaceWrite", networkAccess: false, writableRoots: [] } } };
    expect((withFolderGrants(resolved, { limited: true, grants: [] }, "/work").turn.sandboxPolicy as any).networkAccess).toBe(true);
  });
});
