import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";

import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";

const INPUT_CLASS = "w-full min-w-0 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none disabled:opacity-50";

export function AvatarImageGenerator({
  botLabel,
  disabled,
  generating,
  onGenerate,
}: {
  botLabel: string;
  disabled: boolean;
  generating: boolean;
  onGenerate: (direction: string) => Promise<void>;
}) {
  const { state, dispatch } = useStore();
  const imageGen = state.config?.imageGen;
  const [direction, setDirection] = useState("");
  const busy = disabled || generating;
  const ready = imageGen?.ready ?? imageGen?.configured === true;

  return (
    <div data-avatar-generator>
      {!ready && (
        <p className="mb-3 text-[12px] leading-relaxed text-ink-secondary">
          {t("avatarEditor.generateSetup")}{" "}
          <button
            type="button"
            onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "imageGeneration" })}
            className="cursor-pointer text-accent hover:underline"
          >
            {t("botIdentity.ai.openImageSettings")}
          </button>
        </p>
      )}
      <textarea
        value={direction}
        disabled={busy || !ready}
        onChange={(event) => setDirection(event.target.value.slice(0, 400))}
        maxLength={400}
        placeholder={t("botIdentity.ai.directionPlaceholder", { name: botLabel })}
        aria-label={t("botIdentity.ai.directionLabel")}
        className={`${INPUT_CLASS} min-h-[72px] resize-none`}
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-[11px] tabular-nums text-ink-secondary">{direction.length}/400</span>
        <button
          type="button"
          onClick={() => {
            if (!busy && ready) void onGenerate(direction.trim());
          }}
          disabled={busy || !ready}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
        >
          {generating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
          {generating ? t("botIdentity.ai.generating") : t("botIdentity.ai.generate")}
        </button>
      </div>
    </div>
  );
}
