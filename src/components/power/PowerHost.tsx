import { useEffect, useLayoutEffect } from "react";

import { isEveryBotPaused } from "@/lib/bot-pause";
import { playWake, runWaiting, usePowerWait, workingBotCount } from "@/lib/power";
import { useStore } from "@/state/store";

import { PowerToast } from "./PowerToast";
import { PowerVisor } from "./PowerVisor";

/** Mounted once: the visor and the toast, the wait for working bots, and the wake after a restart. */
export function PowerHost() {
  const { state } = useStore();
  const wait = usePowerWait();
  const working = isEveryBotPaused(state.config) ? 0 : workingBotCount(state.bots);

  useLayoutEffect(() => {
    if (window.ogb?.relaunch) void playWake();
  }, []);

  useEffect(() => {
    if (!wait || working > 0) return;
    const timer = setTimeout(() => runWaiting(), 300);
    return () => clearTimeout(timer);
  }, [wait, working]);

  return (
    <>
      <PowerVisor />
      <PowerToast working={working} />
    </>
  );
}
