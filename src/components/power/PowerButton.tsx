import { Power } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { isEveryBotPaused } from "@/lib/bot-pause";
import { pauseEveryBot, prefersReducedMotion, requestPower, usePowerWait, workingBotCount, type PowerKind } from "@/lib/power";
import { useUpdaterState } from "@/lib/updater";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useStore } from "@/state/store";

import { PowerPill, type PillAction, type PillPlace } from "./PowerPill";

type Phase = "closed" | "open" | "closing";

const PILL_SIZE = 46;
const PILL_EDGE = 8;

function PowerControl({ className }: { className?: string }) {
  const { state, dispatch } = useStore();
  const updater = useUpdaterState();
  const admin = useOwnerOrAdmin();
  const wait = usePowerWait();
  const [phase, setPhase] = useState<Phase>("closed");
  const [place, setPlace] = useState<PillPlace>({ top: 0, left: 0, rtl: false });
  const button = useRef<HTMLButtonElement>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const paused = isEveryBotPaused(state.config);
  const working = paused ? 0 : workingBotCount(state.bots);
  const downloaded = updater?.status === "downloaded" ? updater : null;
  const update = downloaded ? { version: downloaded.version ?? "" } : null;
  const handoff = downloaded?.installMode === "handoff";
  const latest = useRef({ working, update, handoff });
  latest.current = { working, update, handoff };

  const later = (run: () => void, ms: number) => {
    if (ms <= 0) return run();
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      run();
    }, ms);
    timers.current.add(timer);
  };
  useEffect(() => () => {
    for (const timer of timers.current) clearTimeout(timer);
  }, []);

  const close = (focusButton: boolean) => {
    setPhase((now) => (now === "open" ? "closing" : now));
    if (focusButton) button.current?.focus({ preventScroll: true });
    later(() => setPhase((now) => (now === "closing" ? "closed" : now)), prefersReducedMotion() ? 0 : 300);
  };

  useEffect(() => {
    if (phase !== "open") return;
    const keys = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close(true);
    };
    const outside = (event: Event) => {
      const target = event.target as Element | null;
      if (target?.closest?.("[data-power-pill]") || button.current?.contains(target)) return;
      if (document.activeElement?.closest("[data-power-pill]")) button.current?.focus({ preventScroll: true });
      close(false);
    };
    document.addEventListener("keydown", keys);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("keydown", keys);
      document.removeEventListener("pointerdown", outside);
    };
  }, [phase]);

  const toggle = () => {
    if (phase === "open") return close(true);
    const rect = button.current?.getBoundingClientRect();
    if (!rect) return;
    const rtl = getComputedStyle(button.current!).direction === "rtl";
    const centre = rect.left + rect.width / 2;
    const width = 188 + 40 * (admin === true ? 3 : 2);
    const left = rtl
      ? Math.max(PILL_EDGE, window.innerWidth - centre - PILL_SIZE / 2)
      : Math.max(PILL_EDGE, Math.min(centre - PILL_SIZE / 2, window.innerWidth - width - PILL_EDGE));
    setPlace({ top: rect.top + rect.height / 2 - PILL_SIZE / 2, left, rtl });
    setPhase("open");
  };

  const act = (kind: PowerKind) => {
    const { working: busy, update: next, handoff: opensInstaller } = latest.current;
    if (kind === "restart" && next && opensInstaller) {
      void window.ogb?.updater?.install();
      return;
    }
    requestPower(kind, { update: kind === "restart" ? next : null, working: busy });
  };
  const complete = (kind: PowerKind) => {
    const calm = prefersReducedMotion();
    later(() => close(false), calm ? 0 : 240);
    later(() => act(kind), calm ? 0 : 560);
  };
  const pause = () => {
    close(true);
    void pauseEveryBot(!paused, { onError: (message) => dispatch({ type: "error", message }) });
  };

  const actions: PillAction[] = admin === true ? ["shutdown", "restart", "pause"] : ["shutdown", "restart"];
  const light = paused ? "paused" : "on";
  return (
    <>
      <button
        ref={button}
        type="button"
        data-power-button=""
        aria-label={t("power.button")}
        title={t("power.button")}
        aria-haspopup="menu"
        aria-expanded={phase === "open"}
        onClick={toggle}
        className={cn(
          "relative grid size-9 shrink-0 place-items-center rounded-full text-ink-secondary transition-colors duration-[120ms] hover:bg-ink/[0.06] hover:text-ink motion-reduce:transition-none touch:size-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus",
          phase === "open" && "opacity-0",
          className,
        )}
      >
        <Power size={18} aria-hidden="true" />
        <span data-power-light={light} className="power-light" aria-hidden="true" />
        {update && <span data-power-update="" className="power-dot" aria-hidden="true" />}
      </button>
      {phase !== "closed" && (
        <PowerPill
          open={phase === "open"}
          place={place}
          actions={actions}
          update={update}
          working={working}
          paused={paused}
          waiting={wait?.kind ?? null}
          onComplete={complete}
          onPause={pause}
        />
      )}
    </>
  );
}

export function PowerButton({ className }: { className?: string }) {
  return window.ogb?.relaunch ? <PowerControl className={className} /> : null;
}
