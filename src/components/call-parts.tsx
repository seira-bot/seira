import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { lastCaptions, type ActiveCall, type CaptionLine } from "@/lib/call-session";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";

export type CallPopover = "voice" | "captions";

export interface CallPopovers {
  open: CallPopover | null;
  openRef: RefObject<CallPopover | null>;
  root: RefObject<HTMLDivElement | null>;
  toggle: (which: CallPopover) => void;
  close: () => void;
  buttonRef: (which: CallPopover) => (element: HTMLButtonElement | null) => void;
}

/** One popover at a time, opened from a button in `root`. Escape closes it and puts the focus back on its button. */
export function useCallPopovers(): CallPopovers {
  const [open, setOpen] = useState<CallPopover | null>(null);
  const openRef = useRef<CallPopover | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const buttons = useRef<Record<CallPopover, HTMLButtonElement | null>>({ voice: null, captions: null });
  openRef.current = open;

  const close = useCallback(() => setOpen(null), []);
  const toggle = useCallback((which: CallPopover) => setOpen((current) => (current === which ? null : which)), []);
  usePopoverDismiss(open !== null, root, close);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      setOpen(null);
      buttons.current[open]?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const buttonRef = useCallback((which: CallPopover) => (element: HTMLButtonElement | null) => {
    buttons.current[which] = element;
  }, []);

  return { open, openRef, root, toggle, close, buttonRef };
}

export function callStateLabel(call: Pick<ActiveCall, "stage" | "presence" | "pushToTalk">): string {
  if (call.stage === "calling") return t("call.view.calling");
  switch (call.presence) {
    case "ending": return t("call.live.hangingUp");
    case "muted": return t("call.view.muted");
    case "speaking": return t("call.view.speaking");
    case "thinking": return t("call.view.thinking");
    default: return call.pushToTalk ? t("call.turns.pushToTalk") : t("call.turns.listening");
  }
}

export function callStatusLine(call: Pick<ActiveCall, "stage" | "presence" | "pushToTalk">, time: string): string {
  const state = callStateLabel(call);
  return call.stage === "connected" && time ? t("call.view.status", { time, state }) : state;
}

export function CaptionsPopover({ lines, botName }: { lines: readonly CaptionLine[]; botName: string }) {
  const shown = lastCaptions(lines);
  return (
    <div role="dialog" aria-label={t("call.view.captions")} className="popover-surface w-80 max-w-[90vw] rounded-xl border border-hairline/50 bg-menu p-3 text-[13px] leading-5 text-ink shadow-lg">
      {shown.length === 0 ? (
        <p className="text-ink-secondary">{t("call.view.captionsEmpty")}</p>
      ) : (
        <ul role="log" aria-live="polite" className="flex flex-col gap-2">
          {shown.map((line) => (
            <li key={line.id}>
              <span className={cn("font-medium", line.who === "bot" ? "text-accent" : "text-ink-secondary")}>
                {line.who === "bot" ? botName : t("call.view.you")}
              </span>
              <span className="ms-2">{line.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SpeakingWave() {
  return (
    <span aria-hidden className="flex h-4 items-center gap-0.5">
      {[0, 1, 2].map((bar) => <span key={bar} className="call-wave-bar h-4 w-0.5 rounded-full bg-accent" />)}
    </span>
  );
}
