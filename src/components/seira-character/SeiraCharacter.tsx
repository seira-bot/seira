import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { cn } from "@/lib/cn";
import { MAUS_COLORS, type MausColor } from "@/lib/mascot";
import type { SeiraBot } from "../../../brand/mascot/runtime/bot.js";
import { mascotClock, usePrefersReducedMotion } from "../mascot-clock";
import { SEIRA_SCRIPTS, type SeiraState } from "./states";

export interface SeiraCharacterProps {
  state?: SeiraState;
  /** Width and height in px. The character fills the square. */
  size?: number;
  /** A bot color for the hair. Without it, Seira keeps her own silver hair. */
  hairColor?: MausColor;
  /** Screen reader text. Without it, the character is decorative and hidden from screen readers. */
  label?: string;
  className?: string;
}

const FRAME_MS = 1000 / 30;
const MAX_STEP_MS = 100;
const STILL_STEP_MS = 16;

function subscribeRootMotion(onChange: () => void): () => void {
  if (typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-reduced-motion"] });
  return () => observer.disconnect();
}

const readRootMotion = () => document.documentElement.dataset.reducedMotion === "true";

function useReducedMotion(): boolean {
  const media = usePrefersReducedMotion();
  const root = useSyncExternalStore(subscribeRootMotion, readRootMotion, () => false);
  return media || root;
}

export function SeiraCharacter({ state = "idle", size = 160, hairColor, label, className }: SeiraCharacterProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const bot = useRef<SeiraBot | null>(null);
  const [ready, setReady] = useState(false);
  const reduced = useReducedMotion();
  const latest = useRef({ label, hairColor: hairColor ? MAUS_COLORS[hairColor] : null });
  latest.current = { label, hairColor: hairColor ? MAUS_COLORS[hairColor] : null };

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let cancelled = false;
    let created: SeiraBot | null = null;
    let stop: (() => void) | null = null;

    void import("./kit").then(({ loadSeiraKit }) => loadSeiraKit()).then(async (kit) => {
      if (cancelled) return;
      const { label: name, hairColor: hair } = latest.current;
      const next = await kit.createBot(element, { name: name ?? "", hairColor: hair }, {
        bases: kit.bases,
        stickers: kit.stickers,
        manual: true,
        reduced,
      });
      if (cancelled) {
        next.destroy();
        return;
      }
      if (name) element.setAttribute("aria-label", name);
      else element.removeAttribute("aria-label");
      created = next;
      bot.current = next;
      if (!reduced) {
        let last = 0;
        const ticket = mascotClock().add((now) => {
          next.tick(last ? Math.min(MAX_STEP_MS, now - last) : STILL_STEP_MS);
          last = now;
          return now + FRAME_MS;
        }, element);
        stop = () => ticket.remove();
      }
      setReady(true);
    }).catch(() => {});

    return () => {
      cancelled = true;
      stop?.();
      created?.destroy();
      bot.current = null;
      setReady(false);
    };
  }, [reduced]);

  useEffect(() => {
    const current = bot.current;
    if (!ready || !current) return;
    const script = SEIRA_SCRIPTS[state];
    current.setState(script.runtime);
    if (reduced) {
      current.express(script.still ?? "calm");
      current.tick(STILL_STEP_MS);
      return;
    }
    current.express(script.expression ?? "calm", script.expressionMs ? { ms: script.expressionMs } : undefined);
    if (script.action) void current.play(script.action);
  }, [state, ready, reduced]);

  useEffect(() => {
    const current = bot.current;
    if (!ready || !current) return;
    void current.setConfig({ hairColor: latest.current.hairColor }).then(() => {
      if (reduced) current.tick(0);
    });
  }, [hairColor, ready, reduced]);

  useEffect(() => {
    if (ready && reduced) bot.current?.tick(0);
  }, [size, ready, reduced]);

  return (
    <canvas
      ref={canvas}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-seira-state={state}
      className={cn("block shrink-0 touch-pan-y select-none opacity-0 transition-opacity duration-150 motion-reduce:transition-none data-[ready=true]:opacity-100", className)}
      data-ready={ready}
      style={{ width: size, height: size }}
    />
  );
}
