import { useEffect, useRef } from "react";
import { useShowThreads } from "@/lib/thread-preferences";
import { activeLocale } from "@/lib/i18n";
import { buildGlanceFeed, glanceActHandler, glanceAskInputs, glanceBotInputs, glanceLabels } from "./glance-feed";
import { currentInbox, useInboxView } from "./inbox";
import { useStore } from "./store";
import { subscribeAnyTurnLive } from "./turn-status";

export const GLANCE_SEND_DELAY_MS = 250;

/** Tells the desktop app what the bots of the shown place do, for Glance, and answers what the person does there. */
export function useGlance(): void {
  const bridge = typeof window === "undefined" ? undefined : window.ogb?.glance;
  const { state, dispatch } = useStore();
  const view = useInboxView();
  const showThreads = useShowThreads();
  const lang = activeLocale();
  const latest = useRef({ state, dispatch, showThreads });
  latest.current = { state, dispatch, showThreads };
  const schedule = useRef<() => void>(() => {});

  useEffect(() => {
    if (!bridge) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sent = "";
    const send = () => {
      timer = undefined;
      const { state: current } = latest.current;
      const feed = buildGlanceFeed({
        bots: glanceBotInputs(current.bots, current.pendingQueued),
        asks: glanceAskInputs(currentInbox(), current.bots),
        labels: glanceLabels(),
        lang: activeLocale(),
      });
      const json = JSON.stringify(feed);
      if (json === sent) return;
      sent = json;
      bridge.feed(feed);
    };
    schedule.current = () => { if (timer === undefined) timer = setTimeout(send, GLANCE_SEND_DELAY_MS); };
    const unsubscribe = subscribeAnyTurnLive(() => schedule.current());
    return () => { unsubscribe(); schedule.current = () => {}; if (timer !== undefined) clearTimeout(timer); };
  }, [bridge]);

  useEffect(() => { schedule.current(); }, [state.bots, state.pendingQueued, view, lang]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onAct(glanceActHandler({
      dispatch: (action) => latest.current.dispatch(action),
      getState: () => latest.current.state,
      getInbox: currentInbox,
      showThreads: () => latest.current.showThreads,
    }));
  }, [bridge]);
}
