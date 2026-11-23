import type { ProviderUse } from "../shared/provider-uses.ts";

interface UseSelection { instanceId: string }

export interface ProviderUseInput {
  instanceId: string;
  /** The model new bots start with, or null to leave it out. */
  defaultInstanceId: string | null;
  bots: ReadonlyArray<{ id: string; name: string; modelSelection: UseSelection; fallback?: readonly UseSelection[] }>;
  tasks(botId: string): ReadonlyArray<{ threadId: string; title?: string; modelSelection?: UseSelection }>;
  /** The bots with work running now, and the provider each runs on. */
  running: ReadonlyArray<{ botId: string; instanceId: string }>;
}

const TITLE_MAX = 120;

/** Everything that keeps a provider from being hidden or removed. Names only: never message text. */
export function providerUses(input: ProviderUseInput): ProviderUse[] {
  const { instanceId } = input;
  const uses: ProviderUse[] = [];
  if (input.defaultInstanceId === instanceId) uses.push({ kind: "default" });
  for (const bot of input.bots) {
    const named = { botId: bot.id, botName: bot.name };
    if (bot.modelSelection.instanceId === instanceId) uses.push({ kind: "bot", ...named });
    if (bot.fallback?.some((candidate) => candidate.instanceId === instanceId)) uses.push({ kind: "backup", ...named });
    for (const task of input.tasks(bot.id)) {
      if (task.modelSelection?.instanceId === instanceId) {
        uses.push({ kind: "conversation", ...named, threadId: task.threadId, title: (task.title ?? "").slice(0, TITLE_MAX) });
      }
    }
  }
  const working = new Set<string>();
  for (const run of input.running) {
    if (run.instanceId !== instanceId || working.has(run.botId)) continue;
    working.add(run.botId);
    const bot = input.bots.find((candidate) => candidate.id === run.botId);
    if (bot) uses.push({ kind: "running", botId: bot.id, botName: bot.name });
  }
  return uses;
}

/** The uses a caller may be told about. What they cannot see becomes one nameless count. */
export function usesVisibleTo(uses: readonly ProviderUse[], visible: { bot(id: string): boolean; thread(id: string): boolean }): ProviderUse[] {
  let hidden = 0;
  const shown = uses.filter((use) => {
    const ok = use.kind === "default" || use.kind === "other" || (use.kind === "conversation" ? visible.thread(use.threadId) : visible.bot(use.botId));
    if (!ok) hidden += 1;
    return ok;
  });
  return hidden > 0 ? [...shown, { kind: "other", count: hidden }] : shown;
}
