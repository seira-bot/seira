// The AI pool from Settings → AI, set by a bot with Undo. A bot adds only an AI that bills against a plan: a pay-per-use
// AI joins the pool only when the person adds it in the card.
import { z } from "zod";

import { AI_POOL_MODES, type AiPoolMode } from "../../shared/ai-pool.ts";
import type { AppConfig } from "../config.ts";
import type { RegistryDeps, SettingEntry, WritableSpec } from "./registry.ts";

type Pool = NonNullable<AppConfig["aiPool"]>;
type Change = { enabled?: boolean; mode?: AiPoolMode; members?: Array<{ instanceId: string; model: string }>; levels?: number[]; floor?: number };
/** What Undo writes: the whole pool as it was saved, not a change to merge. */
type Restore = { restore: Pool };

const MODE_LABEL: Record<AiPoolMode, string> = { even: "Balance usage", turns: "Take turns", inOrder: "In order" };
const OFF: Pool = { enabled: false, mode: "even", members: [] };

const change = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(AI_POOL_MODES).optional(),
  members: z.array(z.object({ instanceId: z.string().trim().min(1).max(200), model: z.string().trim().min(1).max(500) }).strict()).max(10).optional(),
  levels: z.array(z.number().int().min(1).max(99)).min(1).max(9).optional(),
  floor: z.number().int().min(0).max(98).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "name at least one field");

const joined = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

export function aiPoolEntries(deps: Pick<RegistryDeps, "cfg" | "saveConfig" | "poolEngines">, writable: (spec: WritableSpec) => SettingEntry): SettingEntry[] {
  const engines = () => deps.poolEngines?.() ?? [];
  const saved = (): Pool => deps.cfg().aiPool ?? OFF;
  const nameOf = (instanceId: string) => engines().find((engine) => engine.instanceId === instanceId)?.name ?? instanceId;
  const line = (pool: Pool) => `${MODE_LABEL[pool.mode]}: ${pool.members.map((member) => `${nameOf(member.instanceId)} (${member.model})`).join(", ")}`;
  const addable = () => engines().filter((engine) => engine.billing === "plan");
  const merged = (value: Change): Pool => ({ ...saved(), ...value, members: value.members ?? saved().members });
  const adding = (engine: ReturnType<typeof addable>[number]) => `${engine.name} (id ${engine.instanceId}, model ${engine.model})`;

  const entry = writable({
    id: "ai.pool", label: "AI pool", where: "ai-pool",
    help: "Shares work across several AIs so one plan's limit lasts longer. Turn it on, choose how it shares, and choose the AIs: two to ten, each once. A bot adds only an AI on a plan; only the person adds a pay-per-use AI.",
    synonyms: ["ai pool", "pool", "share usage", "balance usage", "take turns", "round robin", "in order", "spread", "usage limit", "limit"],
    value: change,
    allowed: '{"enabled"?:true|false,"mode"?:"even"|"turns"|"inOrder","members"?:[{"instanceId","model"}] from the list in get,"levels"?:[percent],"floor"?:percent}; send only what changes',
    current: (): Restore => ({ restore: structuredClone(saved()) }),
    read: () => {
      const pool = saved();
      if (!pool.members.length) return pool.enabled ? "on" : "off";
      return `${pool.enabled ? "on" : "off"}, ${line(pool)}`;
    },
    describe: (value: Change) => {
      const next = merged(value);
      const turnsOn = next.enabled && !saved().enabled;
      if (next.enabled && next.members.length < 2) {
        const names = addable().map(adding);
        return { refusal: `The AI pool needs at least two AIs before it turns on. ${names.length >= 2 ? `AIs you can add: ${names.join("; ")}. Set members too.` : "Fewer than two AIs on a plan are signed in. Ask the user to sign in to another one: show_card with card ai-sign-in."} Nothing changed.` };
      }
      if (next.enabled || value.members) {
        const refused = next.members.filter((member) => addable().every((engine) => engine.instanceId !== member.instanceId));
        if (refused.length) {
          return { refusal: `${joined(refused.map((member) => nameOf(member.instanceId)))} cannot be added by you: it is pay per use, or Seira cannot tell how it is billed. Only the person adds a pay-per-use AI to the pool. Nothing changed. Call show_card with card ai-pool so the user can decide, and say so in one line.` };
        }
      }
      if (!next.enabled) return { change: saved().enabled ? "Turn off the AI pool" : `Change the saved AI pool: ${line(next)}` };
      return { change: `${turnsOn ? "Turn on" : "Change"} the AI pool: ${MODE_LABEL[next.mode]}, ${joined(next.members.map((member) => nameOf(member.instanceId)))}` };
    },
    write: (value: Change | Restore) => deps.saveConfig({ aiPool: "restore" in value ? value.restore : merged(value) }),
  });

  const list = () => engines().map((engine) => `${engine.name} (id ${engine.instanceId}, model ${engine.model}, ${engine.billing})`).join("; ");
  const help = entry.help;
  Object.defineProperty(entry, "help", { enumerable: true, get: () => `${help} AIs signed in now: ${list() || "none"}.` });
  return [entry];
}
