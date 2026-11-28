// Where the Store keeps its bots, rooms and their threads. The Store says what changed (one thread, one owner's record,
// an owner gone, the whole list) and how soon it must be on disk; the registry decides how to write that. Today's one
// layout keeps everything in bots.json and groups.json, each rewritten whole for any change: temp file, fsync, rename,
// owner-only, skipped when the text is unchanged. A layout that keeps threads as rows can write one row where this one
// writes a whole file, behind the same calls.
import { chmodSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { flushWritesBehind, OwnedFile } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { batchSaves, saveLater, saveSoon, supersedeLaterSave } from "./save-batch.ts";
import type { BotRecord, GroupRecord } from "./store.ts";

export const BOTS_FILE = join(DATA_DIR, "bots.json");
export const GROUPS_FILE = join(DATA_DIR, "groups.json");

/** A list of records: every element is an object (not a list) with an `id` that is a text that is not empty. Other fields are the work of the migrations. */
export function isListOfRecords(value: unknown): value is Array<{ id: string }> {
  return Array.isArray(value) && value.every((item) => typeof item === "object" && item !== null && !Array.isArray(item) && typeof (item as { id?: unknown }).id === "string" && (item as { id: string }).id !== "");
}

export type RegistryOwner = { kind: "bot" | "group"; id: string };

/**
 * How soon a change must be on disk:
 * - "now": before the call returns, synced. Creates, deletions, permissions, anything a person asked for; a failure
 *   throws, so the caller can put memory back (server/registry-save.ts commitRegistryChange).
 * - "pass": when the running batch ends (`batch`, server/save-batch.ts batchSaves), at once and synced outside one. A
 *   turn's bookkeeping that must survive a crash: an engine session, which engine has the thread, what was handed to it.
 *   At the end of a batch the file's text is taken whole and written behind: it lands, synced, a few milliseconds later
 *   while the server goes on, and any exit with handlers finishes it first (server/atomic.ts OwnedFile.deferWrites).
 *   What it records is true already when it is saved, so nothing waits for it to land.
 * - "later": within SAVE_LATER_MAX_MS (server/save-batch.ts saveLater), written behind too. Only what server/registry-save.ts
 *   DEFERRABLE_FIELDS allows, and a thread's usage: harmless to lose in a crash. Bots only: nothing of a room waits,
 *   and no room save supersedes a waiting write, so the types refuse "later" for a room.
 */
export type RegistryDurability = "now" | "pass" | "later";

export interface RegistryStore {
  /** The saved bots as parsed; throws when nothing readable is saved, which must never read as "every bot was deleted". */
  loadBots(): BotRecord[];
  /** The saved rooms as parsed; throws when nothing readable is saved. */
  loadGroups(): GroupRecord[];
  /** Every bot and its threads as `bots` holds them, synced before it returns (when a "pass" or "later" save of
   * upsertThread runs it, written behind instead). `bots` may be a list that is not live yet (saved first, so a failure
   * leaves memory alone); `current` says it is the live list, holding every change. */
  writeBots(bots: readonly BotRecord[], current: boolean): void;
  /** Every room and its threads as `groups` holds them, synced before it returns (written behind for a "pass" save). */
  writeGroups(groups: readonly GroupRecord[]): void;
  /**
   * One owner's thread changed (`threadId`), or its record or any of its threads (undefined). `write` is the Store's
   * own save of the whole list (what rollback and tests hook); it runs when `durability` says, and it throws for "now".
   * A row layout narrows that save to the one thread; this one writes the whole file.
   */
  upsertThread(owner: RegistryOwner & { kind: "bot" }, threadId: string | undefined, durability: RegistryDurability, write: () => void): void;
  upsertThread(owner: RegistryOwner & { kind: "group" }, threadId: string | undefined, durability: Exclude<RegistryDurability, "later">, write: () => void): void;
  /** An owner and all its threads leave the registry; `write` saves the list without it, synced, before it returns. */
  deleteOwner(owner: RegistryOwner, write: () => void): void;
  /** Saves asked for with "pass" while `run` runs are written once when it returns: one transaction in a row layout. */
  batch<T>(run: () => T): T;
}

/** Owner-only (0600): the registries hold souls, project paths and per-bot settings. Best effort; Windows has no POSIX mode bits. */
function tightenRegistryFile(file: string): void {
  if (process.platform === "win32") return;
  try {
    if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
  } catch {
  }
}

export function persistedPin<T extends { pinned?: boolean }>(task: T): T {
  if (task.pinned === true) return task;
  if (!("pinned" in task)) return task;
  const { pinned: _pinned, ...rest } = task;
  return rest as T;
}

/** What bots.json holds: live state (busy, activity, a turn's start) is never saved. */
export const persistedBots = (bots: readonly BotRecord[]) => bots.map(({ busy: _busy, activity: _activity, ...bot }) => ({ ...bot,
  tasks: bot.tasks?.map(({ busy: _taskBusy, activity: _taskActivity, turnStartedAt: _taskTurnStarted, ...task }) => persistedPin(task)),
}));

/** What groups.json holds: a room's running turn is never saved. */
export const persistedGroups = (groups: readonly GroupRecord[]) => groups.map(({ busyBotId: _busyBotId, turnStartedAt: _turnStartedAt, ...g }) => ({
  ...g,
  ...(g.tasks ? { tasks: g.tasks.map((task) => persistedPin(task)) } : {}),
}));

/** Today's layout: bots.json and groups.json, each the whole list with its threads. */
export class JsonRegistry implements RegistryStore {
  private readonly botsFile = new OwnedFile(BOTS_FILE, { mode: 0o600 });
  private readonly groupsFile = new OwnedFile(GROUPS_FILE, { mode: 0o600 });

  loadBots(): BotRecord[] {
    flushWritesBehind(BOTS_FILE); // what an earlier load still writes behind lands first, as a synchronous save would have
    tightenRegistryFile(BOTS_FILE);
    supersedeLaterSave(BOTS_FILE); // the file is read afresh, so a write still waiting has nothing left to add
    const text = readFileSync(BOTS_FILE, "utf8"), bots = JSON.parse(text) as BotRecord[];
    this.botsFile.loaded(text);
    return bots;
  }

  loadGroups(): GroupRecord[] {
    flushWritesBehind(GROUPS_FILE);
    tightenRegistryFile(GROUPS_FILE);
    const text = readFileSync(GROUPS_FILE, "utf8"), groups: unknown = JSON.parse(text);
    if (!isListOfRecords(groups)) throw new TypeError("groups.json is not a list of rooms");
    this.groupsFile.loaded(text);
    return groups as GroupRecord[];
  }

  writeBots(bots: readonly BotRecord[], current: boolean): void {
    this.botsFile.write(JSON.stringify(persistedBots(bots)));
    if (current) supersedeLaterSave(BOTS_FILE);
  }

  writeGroups(groups: readonly GroupRecord[]): void {
    this.groupsFile.write(JSON.stringify(persistedGroups(groups)));
  }

  upsertThread(owner: RegistryOwner, _threadId: string | undefined, durability: RegistryDurability, write: () => void): void {
    const file = owner.kind === "bot" ? this.botsFile : this.groupsFile;
    if (durability === "pass") saveSoon(file, write, () => file.deferWrites(write));
    else if (durability === "later") saveLater(BOTS_FILE, () => this.botsFile.deferWrites(write)); // bots only (see RegistryDurability)
    else write();
  }

  deleteOwner(_owner: RegistryOwner, write: () => void): void {
    write();
  }

  batch<T>(run: () => T): T {
    return batchSaves(run);
  }
}
