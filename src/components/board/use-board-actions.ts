import { useCallback, useState } from "react";

import type { BoardCard } from "../../../shared/board";
import { useShowThreads } from "@/lib/thread-preferences";
import { loadBoard } from "@/state/board";
import { openThread, useStore } from "@/state/store";

export function useBoardActions() {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const [stopped, setStopped] = useState(false);

  const openConversation = useCallback((card: BoardCard) => {
    if (!card.threadId) return;
    openThread(dispatch, { botId: card.botId, threadId: card.threadId }, state, showThreads);
  }, [dispatch, state, showThreads]);

  const stop = useCallback((card: BoardCard) => {
    if (card.kind === "routine") dispatch({ type: "cancelRoutineRun", runId: card.id.replace(/^routine:/, "") });
    else if (card.groupId) dispatch({ type: "interruptGroup", groupId: card.groupId, threadId: card.threadId });
    else if (card.threadId) dispatch({ type: "interrupt", botId: card.botId, threadId: card.threadId });
    else return;
    setStopped(true);
    window.setTimeout(() => void loadBoard({ background: true }), 600);
  }, [dispatch]);

  return { openConversation, stop, stopped, clearStopped: () => setStopped(false) };
}
