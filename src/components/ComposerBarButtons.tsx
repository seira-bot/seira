import type { CSSProperties } from "react";
import { Mic, Square } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { SIMPLE_CONTROL } from "./composer-simple";

export function ComposerStopButton({ onStop, simple, inSlot, look }: {
  onStop: () => void;
  simple: boolean;
  inSlot: boolean;
  look: { className: string; style?: CSSProperties };
}) {
  return (
    <button
      onClick={onStop}
      aria-label={t("chat.stopTurn")}
      data-composer-stop={simple ? (inSlot ? "slot" : "beside") : undefined}
      className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", !simple ? "text-ink-secondary hover:bg-raised hover:text-ink" : inSlot ? look.className : SIMPLE_CONTROL)}
      style={inSlot ? look.style : undefined}
      title={t("chat.stop")}
    >
      <Square size={simple ? 12 : 14} className="fill-current" />
    </button>
  );
}

export function ComposerMicButton({ recording, onToggle, simple }: { recording: boolean; onToggle: () => void; simple: boolean }) {
  return (
    <button
      onClick={onToggle}
      aria-label={recording ? t("composer.dictation.stop") : t("composer.dictation.start")}
      className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", recording ? "animate-pulse bg-danger/20 text-danger" : simple ? SIMPLE_CONTROL : "text-ink-secondary hover:bg-raised hover:text-ink")}
      title={recording ? t("composer.dictation.stopHint") : t("composer.dictation.hint")}
    >
      <Mic size={16} strokeWidth={1.75} absoluteStrokeWidth className="[&_rect]:fill-current" />
    </button>
  );
}
