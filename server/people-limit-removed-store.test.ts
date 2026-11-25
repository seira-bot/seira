import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SignInAllowList } from "./account-signin.ts";
import { createPeopleLimit, REMOVED_FILE, type PeopleSession } from "./people-limit.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const failing = vi.hoisted(() => ({ writes: false }));
vi.mock("./atomic.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./atomic.ts")>();
  return {
    ...original,
    writeFileAtomic: (file: string, ...rest: unknown[]) => {
      if (failing.writes && file.endsWith("sign-in-removed.json")) throw new Error("disk full");
      return (original.writeFileAtomic as (...args: unknown[]) => unknown)(file, ...rest);
    },
  };
});

const dirs: string[] = [];
afterEach(async () => {
  failing.writes = false;
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

const domain = (...listed: string[]): SignInAllowList => ({ admins: [...listed, "@corp.test"], members: [] });

function setup(lists: SignInAllowList = domain()) {
  const dataDir = mkdtempSync(join(tmpdir(), "seira-removed-"));
  dirs.push(dataDir);
  const state = { sessions: [{ id: "s1", email: "p1@corp.test" }] as PeopleSession[], revoked: [] as string[] };
  const people = createPeopleLimit({
    dataDir, env: {}, lists: () => lists, sessions: () => state.sessions,
    revoke: (id) => { state.revoked.push(id); state.sessions = state.sessions.filter((session) => session.id !== id); },
    applies: true, enterpriseUnlimited: () => false,
  });
  people.admit("p1@corp.test");
  return { dataDir, state, people };
}

describe("the record of who an admin removed", () => {
  it("removes nobody when the record cannot be saved, and says so", () => {
    const { people, state, dataDir } = setup();
    failing.writes = true;
    expect(people.removeJoined("p1@corp.test")).toBe("failed");
    expect(state.revoked).toEqual([]);
    expect(people.status().joined.map((person) => person.email)).toEqual(["p1@corp.test"]);
    expect(people.wasRemoved("p1@corp.test")).toBe(false);
    failing.writes = false;
    expect(people.removeJoined("p1@corp.test")).toBe("removed");
    expect(state.revoked).toEqual(["s1"]);
    expect(readFileSync(join(dataDir, REMOVED_FILE), "utf8")).toContain("p1@corp.test");
  });

  it("lets nobody in through an @domain entry while the record cannot be read, and never writes over it", () => {
    const { people, dataDir } = setup();
    writeFileSync(join(dataDir, REMOVED_FILE), "{ not json");
    expect(people.wasRemoved("p9@corp.test")).toBe(true);
    expect(people.removeJoined("p1@corp.test")).toBe("failed");
    expect(readFileSync(join(dataDir, REMOVED_FILE), "utf8")).toBe("{ not json");
    writeFileSync(join(dataDir, REMOVED_FILE), JSON.stringify({ version: 1, people: ["p2@corp.test", 7] }));
    expect(people.wasRemoved("p9@corp.test")).toBe(true);
  });

  it("treats a record that is a folder, or has no read permission, as unreadable", () => {
    const folder = setup();
    mkdirSync(join(folder.dataDir, REMOVED_FILE));
    expect(folder.people.wasRemoved("p9@corp.test")).toBe(true);
    if (process.getuid?.() === 0) return;
    const locked = setup();
    writeFileSync(join(locked.dataDir, REMOVED_FILE), JSON.stringify({ version: 1, people: [] }));
    chmodSync(join(locked.dataDir, REMOVED_FILE), 0o000);
    expect(locked.people.wasRemoved("p9@corp.test")).toBe(true);
  });

  it("admits an address that a list names itself, whatever the record holds", () => {
    const { people, dataDir } = setup(domain("p9@corp.test"));
    writeFileSync(join(dataDir, REMOVED_FILE), "{ not json");
    expect(people.wasRemoved("p9@corp.test")).toBe(false);
    expect(people.wasRemoved("p8@corp.test")).toBe(true);
  });

  it("treats a missing record as nobody removed", () => {
    const { people } = setup();
    expect(people.wasRemoved("p9@corp.test")).toBe(false);
  });
});
