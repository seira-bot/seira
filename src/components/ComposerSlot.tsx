import type { ReactNode } from "react";

export type SlotState = "voice" | "send" | "stop";

/** The round 32px slot at the end of the bar. It holds voice, Send or Stop, and a state change fades the new control in from 96%. */
export function ComposerSlot({ state, children }: { state: SlotState; children: ReactNode }) {
  return (
    <span key={state} data-composer-slot={state} className="animate-slot-morph flex shrink-0 items-center">
      {children}
    </span>
  );
}
