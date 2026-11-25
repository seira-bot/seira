import { expect, it } from "vitest";
import { SessionRegistry } from "./sessions.ts";
import { moveOutRefusal } from "./workspace-backup-move-out.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

it("lets a move-out sign-in read its own export and refuses everything else", () => {
  const session = { moveOut: ID };
  expect(moveOutRefusal(session, "GET", `/api/workspace-backup/download/${ID}`)).toBeNull();
  expect(moveOutRefusal(session, "GET", `/api/workspace-backup/download/${OTHER}`)).not.toBeNull();
  expect(moveOutRefusal(session, "POST", `/api/workspace-backup/download/${ID}`)).not.toBeNull();
  expect(moveOutRefusal(session, "GET", `/api/workspace-backup/download/${ID}/extra`)).not.toBeNull();
  expect(moveOutRefusal(session, "GET", "/api/workspace-backup/status")).not.toBeNull();
  expect(moveOutRefusal(session, "GET", "/api/auth/session")).not.toBeNull();
});

it("leaves every other sign-in alone", () => {
  expect(moveOutRefusal({}, "GET", "/api/workspace-backup/status")).toBeNull();
});

it("issues a sign-in that never renews, ends with its export, and stays out of the person's own sessions", () => {
  const dir = mkdtempSync(join(tmpdir(), "seira-move-out-"));
  try {
    const registry = new SessionRegistry({ file: join(dir, "sessions.json") });
    const soon = Date.now() + 10 * 60_000;
    const { token, session } = registry.issueMoveOut({ exportId: ID, expiresAt: soon });
    expect(session.expiresAt).toBe(soon);
    const found = registry.authenticate(token);
    expect(found?.moveOut).toBe(ID);
    expect(found?.token).toBe(true);
    registry.renew(found!.id);
    expect(registry.authenticate(token)?.expiresAt).toBe(soon);
    expect(registry.revokeMoveOuts(OTHER)).toBe(0);
    expect(registry.revokeMoveOuts(ID)).toBe(1);
    expect(registry.authenticate(token)).toBeNull();
    // It survives a restart of the registry until it ends, so a restart does not widen it.
    const again = registry.issueMoveOut({ exportId: ID, expiresAt: soon });
    expect(new SessionRegistry({ file: join(dir, "sessions.json") }).authenticate(again.token)?.moveOut).toBe(ID);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
