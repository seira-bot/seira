// How much memory all bot work on this computer may use together.
import { boxMemory } from "./box-memory.ts";

export const GIB = 1024 ** 3;
const MB = 1024 * 1024;
export const BOT_MEMORY_MAX_ENV = "SEIRA_BOT_MEMORY_MAX_MB";

export type BudgetSource = "env" | "setting" | "auto";
export interface BotBudget { bytes: number; source: BudgetSource }

/** The machine's memory minus the larger of 3 GiB and a quarter of it, never below the smaller of 1 GiB and half of it. */
export function defaultBotBudget(totalBytes: number): number {
  return Math.max(Math.min(GIB, totalBytes / 2), totalBytes - Math.max(3 * GIB, totalBytes * 0.25));
}

/** The number of GB a person may save: finite, at least 1, at most the machine's memory. */
export function validBotMemoryGb(gb: unknown, totalBytes: number): gb is number {
  return typeof gb === "number" && Number.isFinite(gb) && gb >= 1 && gb <= totalBytes / GIB;
}

/** The environment number wins over Settings. `off` or 0 means no protection (null). */
export function botMemoryBudget(input: { env: NodeJS.ProcessEnv; settingGb?: number | null; totalBytes: number }): BotBudget | null {
  const raw = input.env[BOT_MEMORY_MAX_ENV]?.trim().toLowerCase();
  if (raw === "off" || raw === "0") return null;
  if (raw && /^\d+$/.test(raw)) return { bytes: Number(raw) * MB, source: "env" };
  const gb = input.settingGb;
  if (typeof gb === "number" && Number.isFinite(gb)) return { bytes: Math.min(input.totalBytes, Math.max(GIB, gb * GIB)), source: "setting" };
  return { bytes: defaultBotBudget(input.totalBytes), source: "auto" };
}

let settingSource: () => number | null | undefined = () => undefined;

/** config.ts tells this module where the saved number lives, so a change shows at the next engine start. */
export function useBotMemorySetting(read: () => number | null | undefined): void { settingSource = read; }

export const savedBotMemoryGb = (): number | null | undefined => { try { return settingSource(); } catch { return undefined; } };

/** The machine's memory this server sees. */
export const machineMemoryBytes = (): number => boxMemory().bytes;

/** The budget now: env, then the saved setting, then the default. Null when protection is off. */
export function currentBotBudget(env: NodeJS.ProcessEnv = process.env): BotBudget | null {
  return botMemoryBudget({ env, settingGb: savedBotMemoryGb(), totalBytes: machineMemoryBytes() });
}

const oneDecimal = (bytes: number) => Math.round((bytes / GIB) * 10) / 10;

export interface BotMemoryStatus {
  /** The saved number; null for Auto. */
  gb: number | null;
  autoGb: number;
  machineGb: number;
  protection: "slice" | "watchdog" | "none";
  /** Set when the environment fixes the number, so Settings cannot change it. */
  envGb: number | null;
}

export function botMemoryStatusOf(input: { savedGb: number | null | undefined; env: NodeJS.ProcessEnv; totalBytes: number; protection: BotMemoryStatus["protection"] }): BotMemoryStatus {
  const budget = botMemoryBudget({ env: input.env, settingGb: null, totalBytes: input.totalBytes });
  return {
    gb: typeof input.savedGb === "number" ? Math.round(input.savedGb * 10) / 10 : null,
    autoGb: oneDecimal(defaultBotBudget(input.totalBytes)),
    machineGb: oneDecimal(input.totalBytes),
    protection: input.protection,
    envGb: budget?.source === "env" ? oneDecimal(budget.bytes) : null,
  };
}

export const gbText = (bytes: number): string => String(oneDecimal(bytes));
