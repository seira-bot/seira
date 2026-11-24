import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanNeedsAction } from "./workspace-backup-needs-action.ts";
import { applyPendingWorkspaceRestore, commitPendingWorkspaceRestore, createWorkspaceBackup, readLastWorkspaceRestore, stageWorkspaceBackup } from "./workspace-backup.ts";

const PASSWORD = "correct horse battery staple";
const PLANTED = "PLANTED-SECRET-9f3a";
const scratch: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "seira-needs-action-"));
  scratch.push(path);
  return path;
}
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
const json = (root: string, name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value));

/** A data folder with the given records on, off and secret in places a list must never copy. */
function source(on: { routines: number; webhooks: number; appTriggers: number }): string {
  const root = directory();
  json(root, "bots.json", []);
  json(root, "groups.json", []);
  type Entry = { id: string; enabled: boolean; name?: string; url?: string };
  const records = (count: number): Entry[] => [...Array.from({ length: count }, (_, index): Entry => ({ id: `on${index}`, enabled: true, name: PLANTED, url: `https://${PLANTED}.example` })), { id: "off", enabled: false }];
  json(root, "routines.json", { version: 1, routines: records(on.routines), runs: [] });
  json(root, "webhooks.json", { version: 1, webhooks: records(on.webhooks).map(({ id, enabled, name }) => ({ id, endpointId: `e-${id}`, enabled, name })) });
  json(root, "app-triggers.json", { version: 1, pollerId: "poller-source-0001", cursor: 0, triggers: records(on.appTriggers), attempts: [], deleted: [] });
  mkdirSync(join(root, "workspaces"), { recursive: true });
  return root;
}
async function restore(root: string): Promise<{ target: string; result: ReturnType<typeof applyPendingWorkspaceRestore> }> {
  const exported = await createWorkspaceBackup(root, { password: PASSWORD });
  const target = directory();
  const staged = await stageWorkspaceBackup(target, exported.path, { password: PASSWORD });
  commitPendingWorkspaceRestore(target, staged.id);
  return { target, result: applyPendingWorkspaceRestore(target) };
}

describe("restore receipt: needs action", () => {
  it("lists a kind with its count for each kind that was on, counted before the restore turns it off", async () => {
    const { target, result } = await restore(source({ routines: 2, webhooks: 1, appTriggers: 3 }));
    const expected = [{ kind: "routines-on", count: 2 }, { kind: "webhooks-on", count: 1 }, { kind: "app-automations-on", count: 3 }];
    expect(result.needsAction).toEqual(expected);
    expect(readLastWorkspaceRestore(target)!.needsAction).toEqual(expected);
    // The restore itself is unchanged: every routine is off afterwards.
    expect(JSON.parse(readFileSync(join(target, "routines.json"), "utf8")).routines.every((routine: any) => routine.enabled === false)).toBe(true);
  });

  it("never carries a name, address or planted secret from the restored data", async () => {
    const { target, result } = await restore(source({ routines: 2, webhooks: 1, appTriggers: 1 }));
    expect(JSON.stringify(result)).not.toContain(PLANTED);
    expect(readFileSync(join(target, ".backups", "last-restore.json"), "utf8")).not.toContain(PLANTED);
    for (const item of result.needsAction!) expect(Object.keys(item).sort()).toEqual(["count", "kind"]);
  });

  it("gives an empty list for a backup with none of these on", async () => {
    const { target, result } = await restore(source({ routines: 0, webhooks: 0, appTriggers: 0 }));
    expect(result.needsAction).toEqual([]);
    expect(readLastWorkspaceRestore(target)!.needsAction).toEqual([]);
  });

  it("still loads the receipt of an older restore that has no list", async () => {
    const { target } = await restore(source({ routines: 1, webhooks: 0, appTriggers: 0 }));
    const path = join(target, ".backups", "last-restore.json");
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    delete receipt.needsAction;
    writeFileSync(path, JSON.stringify(receipt));
    expect(readLastWorkspaceRestore(target)).toMatchObject({ restored: true, id: receipt.id, needsAction: null });
  });

  it("drops a receipt item that is not a known kind with a whole count", () => {
    expect(cleanNeedsAction([
      { kind: "routines-on", count: 2, name: PLANTED },
      { kind: "routines-on", count: 5 },
      { kind: "webhooks-on", count: 0 },
      { kind: "webhooks-on", count: 1.5 },
      { kind: "app-automations-on", count: "3" },
      { kind: "api-key", count: 1 },
      { kind: PLANTED, count: 1 },
      null, "x", 7,
    ])).toEqual([{ kind: "routines-on", count: 2 }]);
    expect(cleanNeedsAction(undefined)).toEqual([]);
    expect(cleanNeedsAction({ kind: "routines-on", count: 1 })).toEqual([]);
  });
});
