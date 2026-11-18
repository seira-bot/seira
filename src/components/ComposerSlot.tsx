import { useLayoutEffect, useRef, type ReactNode } from "react";

export type SlotState = "voice" | "send" | "stop";

export function ComposerSlot({ state, children }: { state: SlotState; children: ReactNode }) {
  const slot = useRef<HTMLSpanElement>(null);
  const previous = useRef(state);
  const focused = useRef(false);
  useLayoutEffect(() => {
    if (previous.current === state) return;
    previous.current = state;
    const node = slot.current;
    if (!node) return;
    if (focused.current && (!document.activeElement || document.activeElement === document.body)) {
      node.querySelector<HTMLElement>("button")?.focus();
    }
    if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches && document.documentElement.dataset.reducedMotion !== "true") {
      node.animate?.([{ opacity: 0, transform: "scale(0.96)" }, { opacity: 1, transform: "none" }], { duration: 150, easing: "ease-out" });
    }
  }, [state]);
  return (
    <span
      ref={slot}
      data-composer-slot={state}
      onFocus={() => { focused.current = true; }}
      onBlur={(event) => { if (event.relatedTarget) focused.current = false; }}
      className="flex shrink-0 items-center"
    >
      {children}
    </span>
  );
}
