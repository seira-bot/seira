import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Bot } from "@/state/store";
import type { ActivityRow } from "@/lib/activity";
import { listenLiveFrames } from "@/lib/live-events";

export function useBotActivity(bot: Bot, limit: number): {
  rows: ActivityRow[] | null;
  error: string | null;
  reload: () => Promise<void>;
  threadIds: Set<string>;
} {
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadAbort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    try {
      const res = await fetch(`/api/bots/${bot.id}/activity?limit=${limit}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`${res.status}`);
      // SAFETY: the same-version harness's typed activity endpoint; malformed transport data is handled by catch.
      const next = (await res.json()) as { rows: ActivityRow[] };
      if (controller.signal.aborted) return;
      setRows(next.rows);
      setError(null);
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (loadAbort.current === controller) loadAbort.current = null;
    }
  }, [bot.id, limit]);

  useEffect(() => {
    setRows(null);
    void load();
    return () => loadAbort.current?.abort();
  }, [load]);

  const threadKey = [bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)].join("\n");
  const threadIds = useMemo(() => new Set(threadKey.split("\n")), [threadKey]);
  useEffect(() => {
    let settle: ReturnType<typeof setTimeout> | null = null;
    const stopLive = listenLiveFrames({
      onMissedFrames: () => void load(),
      onFrame: (frame) => {
        if (frame.kind !== "runtime") return;
        const runtime = frame.event;
        if (!threadIds.has(runtime.threadId)) return;
        if (
          runtime.type === "turn.completed" ||
          runtime.type === "runtime.error" ||
          runtime.type === "request.opened" ||
          runtime.type === "request.resolved" ||
          runtime.type === "item.completed"
        ) {
          if (settle) clearTimeout(settle);
          settle = setTimeout(() => void load(), 400);
        }
      },
    });
    return () => {
      stopLive();
      if (settle) clearTimeout(settle);
    };
  }, [threadIds, load]);

  return { rows, error, reload: load, threadIds };
}
