import type { ModelSelection } from "../../shared/wire.ts";
import { AI_POOL_LEVELS, pickPoolMember, type AiPoolConfig } from "../ai-pool.ts";

const MAX_TRACKED_THREADS = 2000;

export interface AiPoolDeps {
  config(): AiPoolConfig | undefined;
  threadModel(botId: string, threadId: string): ModelSelection | null;
  reading(instanceId: string): { remaining: number | null; resetsAt: number | null };
  canRun(botId: string, threadId: string, from: ModelSelection, to: ModelSelection): boolean;
  moveTo(botId: string, threadId: string, from: ModelSelection, to: ModelSelection): boolean;
  note(threadId: string, line: string): void;
  engineName(instanceId: string): string;
}

export function createAiPool(deps: AiPoolDeps) {
  const threadLevels = new Map<string, number>();
  const remember = (threadId: string, level: number) => {
    threadLevels.delete(threadId);
    threadLevels.set(threadId, level);
    if (threadLevels.size > MAX_TRACKED_THREADS) threadLevels.delete(threadLevels.keys().next().value!);
  };
  const active = () => {
    const pool = deps.config();
    return pool?.enabled && pool.members.length >= 2 ? pool : undefined;
  };

  return {
    /** At the start of a turn: moves the conversation to the member that should take it. True when it moved. */
    place(botId: string, threadId: string): boolean {
      const pool = active(), current = deps.threadModel(botId, threadId);
      if (!pool || !current) return false;
      const currentIndex = pool.members.findIndex((member) => member.instanceId === current.instanceId);
      if (currentIndex === -1) return false;
      const members = pool.members.map((member, index) => ({
        eligible: deps.canRun(botId, threadId, current, index === currentIndex ? current : member),
        ...deps.reading(member.instanceId),
      }));
      const mode = pool.mode;
      const picked = pickPoolMember({ mode, levels: pool.levels ?? AI_POOL_LEVELS, floor: pool.floor ?? 0, members, currentIndex, threadLevel: threadLevels.get(threadId) });
      if (picked.index === currentIndex) {
        remember(threadId, picked.threadLevel);
        return false;
      }
      const to = pool.members[picked.index]!;
      if (!deps.moveTo(botId, threadId, current, to)) return false;
      remember(threadId, picked.threadLevel);
      const [from, next] = [deps.engineName(current.instanceId), deps.engineName(to.instanceId)];
      deps.note(threadId, mode === "inOrder" ? `The AI pool uses ${next} next, so this conversation moved from ${from} to ${next}.`
        : `${next} has more usage left, so this conversation moved from ${from} to ${next}.`);
      return true;
    },
    /** The other members, in pool order, for a conversation that cannot go on with `from`. */
    backupsFor(from: ModelSelection): ModelSelection[] {
      const pool = active();
      return pool?.members.some((member) => member.instanceId === from.instanceId)
        ? pool.members.filter((member) => member.instanceId !== from.instanceId) : [];
    },
  };
}
