import { Check, Layers } from "lucide-react";
import type { InstanceInfo, ModelSelection } from "@/state/store";
import { activePool, poolPick, poolRuns, type AiPool, type PoolTaskMark } from "@/lib/ai-pool";
import { useEngineLimits } from "@/lib/limit-resets";
import { t } from "@/lib/i18n";

export interface PoolMenuRow {
  runs: boolean;
  meta: string;
  onPick: () => void;
  /** Keeps this conversation on its current AI, out of the pool. */
  onPin: () => void;
}

export interface PoolChoice {
  pool: AiPool | undefined;
  runs: boolean;
  title: string | undefined;
  row: PoolMenuRow | null;
}

export function useAiPoolChoice(input: {
  config: { aiPool?: AiPool | undefined };
  instances: readonly InstanceInfo[];
  selection: ModelSelection;
  task: PoolTaskMark | undefined;
  botModel: ModelSelection;
  name: string;
  canChange: boolean;
  onPick: (target: ModelSelection) => void;
  onPin: () => void;
}): PoolChoice {
  const limits = useEngineLimits();
  const pool = activePool(input.config);
  const runs = poolRuns(pool, input.task, input.botModel);
  if (!pool) return { pool, runs, title: undefined, row: null };
  const title = runs ? t("model.pool.title", { name: input.name }) : undefined;
  if (!input.canChange || !input.task) return { pool, runs, title, row: null };
  const meta = runs ? t("model.pool.now", { name: input.name }) : t("model.pool.shares", { count: pool.members.length });
  const onPick = () => {
    const target = poolPick(pool, input.instances, limits, input.selection, Date.now());
    if (target) input.onPick(target);
  };
  return { pool, runs, title, row: { runs, meta, onPick, onPin: input.onPin } };
}

export function AiPoolRow({ row }: { row: PoolMenuRow }) {
  return (
    <button type="button" data-ai-pool-row data-menu-row aria-pressed={row.runs} onClick={row.onPick}
      className="flex h-9 w-full shrink-0 items-center justify-between gap-2 border-b-[0.5px] border-ink/10 px-3.5 text-left text-[13px] leading-[18px] text-ink hover:bg-ink/[0.06] focus:bg-ink/[0.06]">
      <span className="flex min-w-0 items-center gap-2">
        <Layers size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />
        <span className="shrink-0 font-medium">{t("model.pool.row")}</span>
        <span className="truncate text-[12px] leading-4 text-ink-tertiary">{row.meta}</span>
      </span>
      {row.runs && <Check size={14} className="shrink-0 text-ink" aria-hidden="true" />}
    </button>
  );
}
