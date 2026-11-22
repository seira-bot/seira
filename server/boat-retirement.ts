// Boat is gone: what it left in a data folder is turned into what the same install means without it. A bot's cloud
// computer is the person's own VPS, so a bot that worked on Boat moves to its VPS when one is set up and to no computer
// when none is. Nothing moves to this computer or to a virtual machine, as that would be a place nobody chose.
//
// Each step is a plain rewrite that finds nothing the second time, never throws, and logs counts only: never a bot,
// routine, webhook or key. The Boat key itself is deleted from config.json with a dated copy kept first.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { readConfigFile, writeConfigBackup } from "./config-backup.ts";
import { isValidSshAlias } from "./config.ts";
import { parseJson, type JsonObject, type JsonValue } from "./schema.ts";

export interface BoatRetirementCounts {
  bots: number; pins: number; defaults: number; routines: number; runs: number; webhooks: number; appTriggers: number; key: number;
}

type Row = Record<string, unknown>;
type Log = (line: string) => void;

const isRow = (value: unknown): value is Row => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter(isRow) : []);

/** Where a Cloud choice goes: the bot's VPS when it has one, otherwise no computer. */
function movesCloud(profile: Row, hasVps: boolean): boolean {
  const cloud = profile.computer === "cloud";
  if (!(cloud && profile.cloudBackend !== "vps") && profile.cloudBackend !== "box") return false;
  if (hasVps) profile.cloudBackend = "vps";
  else { delete profile.cloudBackend; if (cloud) profile.computer = "off"; }
  return true;
}

/** Bots first: a conversation pinned to Cloud follows its bot's backend, so a pin needs no change where the bot has a
 * VPS and still means Cloud there. A pin a turn made on its own is dropped where there is none, as it was never chosen;
 * one a person chose stays, and Cloud without a VPS runs the turn without a computer. */
export function retireBoatFromBots(bots: readonly Row[], defaultAlias: string | null | undefined): { bots: number; pins: number } {
  const counts = { bots: 0, pins: 0 };
  for (const bot of bots) {
    // A settings file that cannot be read says nothing about a default VPS: a bot that depends on it is left for the next start.
    if (!isValidSshAlias(bot.vpsAlias) && defaultAlias === undefined) continue;
    const hasVps = isValidSshAlias(bot.vpsAlias) || Boolean(defaultAlias);
    if (movesCloud(bot, hasVps)) counts.bots++;
    if (hasVps) continue;
    for (const task of rows(bot.tasks)) {
      if (task.surface === "cloud" && task.surfaceSource === "auto") { delete task.surface; delete task.surfaceSource; counts.pins++; }
    }
  }
  return counts;
}

/** The default VPS alias as config.json holds it; null when none is set (or there is no file); undefined when the file
 * exists and cannot be read, which is not the same as no VPS. */
function defaultVpsAlias(dataDir: string): string | null | undefined {
  const read = readConfigFile(join(dataDir, "config.json"));
  if (read.state === "unreadable" || read.state === "invalid") return undefined;
  const vps = read.state === "ok" && isRow(read.value.vps) ? read.value.vps : undefined;
  return isValidSshAlias(vps?.sshAlias) ? vps.sshAlias : null;
}

/** For the bot store at start. True when a bot changed and the store must save. */
export function retireBoatFromBotsAtBoot(dataDir: string, bots: readonly unknown[], log: Log = console.warn): boolean {
  try {
    const { bots: moved, pins } = retireBoatFromBots(bots.filter(isRow), defaultVpsAlias(dataDir));
    if (moved + pins > 0) log(`[boat] moved ${moved} bots off Boat and cleared ${pins} automatic cloud pins`);
    return moved + pins > 0;
  } catch {
    log("[boat] could not move the bots off Boat; they are left as they are");
    return false;
  }
}

const RUNNING_STATES = new Set(["queued", "running", "waiting"]);

const PAUSED_RUN = "This ran on a cloud computer that is gone. Choose where the bot works, then run it again.";

/** A routine, webhook or app event that ran in the Boat VM no longer says Cloud, so it would follow the bot's computer or
 * a pin on the conversation it reuses: this computer or a virtual machine, which nobody chose for it. It is switched off,
 * and its waiting runs are cancelled, until the person chooses where it works. */
function retireRunOn(file: string, key: "routines" | "webhooks" | "triggers", runs: boolean): { rows: number; runs: number } | null {
  if (!existsSync(file)) return null;
  const disk = parseJson(readFileSync(file, "utf8")) as JsonValue;
  if (!isRow(disk)) return null;
  const counts = { rows: 0, runs: 0 };
  const retire = (row: Row, counter: "rows" | "runs") => {
    if (row.runOn !== "cloud") return;
    row.runOn = "seira";
    counts[counter]++;
    if (counter === "rows") { row.enabled = false; row.placeLost = true; if ("nextRunAt" in row) row.nextRunAt = null; }
    else Object.assign(row, { status: "cancelled", error: PAUSED_RUN, finishedAt: Date.now() });
  };
  for (const row of rows(disk[key])) retire(row, "rows");
  for (const entry of rows(disk.deleted)) for (const kept of Object.values(entry)) if (isRow(kept)) retire(kept, "rows");
  if (runs) for (const run of rows(disk.runs)) if (RUNNING_STATES.has(String(run.status))) retire(run, "runs");
  if (counts.rows + counts.runs === 0) return counts;
  writeFileAtomic(file, JSON.stringify(disk, null, 2), { mode: 0o600 });
  return counts;
}

/** The Boat key leaves config.json, and new-bot defaults are moved like any bot. */
function retireConfig(dataDir: string): { key: number; defaults: number } | null {
  const path = join(dataDir, "config.json");
  const read = readConfigFile(path);
  if (read.state !== "ok") return null;
  const disk: JsonObject = read.value;
  const profile = isRow(disk.newBotDefaults) && isRow(disk.newBotDefaults.profile) ? disk.newBotDefaults.profile : undefined;
  const alias = isRow(disk.vps) && isValidSshAlias(disk.vps.sshAlias);
  const counts = { key: "box" in disk ? 1 : 0, defaults: profile && movesCloud(profile, alias) ? 1 : 0 };
  if (counts.key + counts.defaults === 0) return counts;
  delete disk.box;
  if (!writeConfigBackup(path, read.text)) return null;
  writeFileAtomic(path, JSON.stringify(disk, null, 2), { mode: 0o600 });
  return counts;
}

/** Before the settings and the saved routines are read. Each file is its own step, so one that cannot be read leaves
 * the others to run and is tried again at the next start. */
export function retireBoatFromFiles(dataDir: string, log: Log = console.warn): BoatRetirementCounts {
  const counts: BoatRetirementCounts = { bots: 0, pins: 0, defaults: 0, routines: 0, runs: 0, webhooks: 0, appTriggers: 0, key: 0 };
  const step = (run: () => void) => { try { run(); } catch { log("[boat] one saved file could not be updated and is left as it is"); } };
  step(() => { const done = retireConfig(dataDir); if (done) { counts.key = done.key; counts.defaults = done.defaults; } });
  step(() => { const done = retireRunOn(join(dataDir, "routines.json"), "routines", true); if (done) { counts.routines = done.rows; counts.runs = done.runs; } });
  step(() => { const done = retireRunOn(join(dataDir, "webhooks.json"), "webhooks", false); if (done) counts.webhooks = done.rows; });
  step(() => { const done = retireRunOn(join(dataDir, "app-triggers.json"), "triggers", false); if (done) counts.appTriggers = done.rows; });
  const { key, defaults, routines, runs, webhooks, appTriggers } = counts;
  if (key + defaults + routines + runs + webhooks + appTriggers > 0) {
    log(`[boat] removed ${key} Boat keys, moved ${defaults} new-bot defaults, ${routines} routines, ${runs} pending runs, ${webhooks} webhooks and ${appTriggers} app automations off Boat`);
  }
  return counts;
}
