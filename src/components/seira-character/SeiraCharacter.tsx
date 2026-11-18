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
  /** A hair style id of the character kit. Without it, Seira keeps her own hair. */
  hairStyle?: string;
  /** A bot color for the hair. Without it, Seira keeps her own silver hair, and the other styles take silver. */
  hairColor?: MausColor;
  /** Accessory ids, at most one for each slot. */
  accessories?: readonly string[];
  /** Screen reader text. Without it, the character is decorative and hidden from screen readers. */
  label?: string;
  className?: string;
}

const SEIRA_STYLE = "seira";
/** The runtime paints a recolored style dark when it gets no color. This silver is the median of Seira's own hair. */
const SEIRA_SILVER = "#DADADF";
const NO_ACCESSORIES: readonly string[] = [];
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

function hairPaint(hairStyle: string, hairColor: MausColor | undefined): string | null {
  if (hairColor) return MAUS_COLORS[hairColor];
  return hairStyle === SEIRA_STYLE ? null : SEIRA_SILVER;
}

export function SeiraCharacter({ state = "idle", size = 160, hairStyle = SEIRA_STYLE, hairColor, accessories = NO_ACCESSORIES, label, className }: SeiraCharacterProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const bot = useRef<SeiraBot | null>(null);
  const [ready, setReady] = useState(false);
  const reduced = useReducedMotion();
  const accessoryKey = accessories.join(",");
  const latest = useRef({ label, hairStyle, accessories, hairColor: hairPaint(hairStyle, hairColor) });
  latest.current = { label, hairStyle, accessories, hairColor: hairPaint(hairStyle, hairColor) };

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let cancelled = false;
    let created: SeiraBot | null = null;
    let stop: (() => void) | null = null;

    void import("./kit").then(({ loadSeiraKit }) => loadSeiraKit()).then(async (kit) => {
      if (cancelled) return;
      const { label: name, hairColor: hair, hairStyle: style, accessories: worn } = latest.current;
      const next = await kit.createBot(element, { name: name ?? "", hairColor: hair, style, accessories: worn }, {
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
    const { hairColor: hair, hairStyle: style, accessories: worn } = latest.current;
    void current.setConfig({ hairColor: hair, style, accessories: worn }).then(() => {
      if (reduced) current.tick(0);
    });
  }, [hairColor, hairStyle, accessoryKey, ready, reduced]);

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
