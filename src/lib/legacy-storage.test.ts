import { describe, expect, it } from "vitest";
import { applyWorkspaceClientState } from "./workspace-backup-client";
import { currentClientStateKeys, migrateLegacyStorage } from "./legacy-storage";

function memory(values: Record<string, string>) {
  const entries = new Map(Object.entries(values));
  return {
    entries,
    get length() { return entries.size; },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  };
}

describe("browser storage from an earlier version", () => {
  it("moves each old key to the current name", () => {
    const storage = memory({ "omb-drafts": "a", "omb.skin": "b", "openmausbot.x": "c", "openmausbot-y": "d", "openmausbot:z": "e", other: "f" });
    migrateLegacyStorage(storage);
    expect(Object.fromEntries(storage.entries)).toEqual({ "seira-drafts": "a", "seira.skin": "b", "seira.x": "c", "seira-y": "d", "seira:z": "e", other: "f" });
  });

  it("leaves current keys untouched", () => {
    const storage = memory({ "seira-drafts": "new", other: "x" });
    migrateLegacyStorage(storage);
    expect(Object.fromEntries(storage.entries)).toEqual({ "seira-drafts": "new", other: "x" });
  });

  it("keeps the current value when both exist, and drops the old key", () => {
    const storage = memory({ "omb-drafts": "old", "seira-drafts": "new" });
    migrateLegacyStorage(storage);
    expect(Object.fromEntries(storage.entries)).toEqual({ "seira-drafts": "new" });
  });

  it("does nothing the second time", () => {
    const storage = memory({ "omb-drafts": "a" });
    migrateLegacyStorage(storage);
    const once = Object.fromEntries(storage.entries);
    migrateLegacyStorage(storage);
    expect(Object.fromEntries(storage.entries)).toEqual(once);
  });

  it("maps old keys of a restored backup, preferring the current key", () => {
    expect(currentClientStateKeys({ "omb-drafts": "old", "seira-drafts": "new", "omb-skin": "s" })).toEqual({ "seira-drafts": "new", "seira-skin": "s" });
  });

  it("restores a backup that names the old keys", () => {
    const storage = memory({ "auth-token": "keep" });
    applyWorkspaceClientState({ "omb-drafts": "restored" }, storage);
    expect(Object.fromEntries(storage.entries)).toEqual({ "seira-drafts": "restored", "auth-token": "keep" });
  });
});
