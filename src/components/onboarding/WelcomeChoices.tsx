import { useRef, type KeyboardEvent } from "react";
import { InstanceProviderMark } from "@/components/ProviderIcons";
import { cn } from "@/lib/cn";
import { engineDisplayName } from "@/lib/engine-name";
import { t } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";

/** The first screen's AI choices: one radio each, the arrow keys move between them. */
export function WelcomeChoices({ choices, selected, onSelect, line }: {
  choices: readonly InstanceInfo[];
  selected: InstanceInfo | undefined;
  onSelect: (instanceId: string) => void;
  line: (instance: InstanceInfo) => string;
}) {
  const group = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = Math.max(0, choices.findIndex((choice) => choice.instanceId === selected?.instanceId));
    const last = choices.length - 1;
    const to = event.key === "ArrowRight" || event.key === "ArrowDown" ? (at + 1) % choices.length
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (at + last) % choices.length
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : -1;
    if (to < 0) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(choices[to].instanceId);
    group.current?.querySelectorAll<HTMLElement>("[role=radio]")[to]?.focus();
  };
  return (
    <div ref={group} role="radiogroup" aria-label={t("onboarding.meet.choices")} data-welcome-choices="" onKeyDown={move}
      className="absolute left-1/2 top-[calc(50%+88px)] grid w-[348px] max-w-[calc(100%-32px)] -translate-x-1/2 grid-cols-3 gap-2">
      {choices.map((instance) => {
        const on = instance.instanceId === selected?.instanceId;
        return (
          <button key={instance.instanceId} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1}
            data-welcome-choice={instance.instanceId} onClick={() => onSelect(instance.instanceId)}
            className={cn("flex flex-col items-center gap-1.5 rounded-[14px] border-[0.5px] px-2 py-2.5 text-center transition-colors",
              on ? "border-accent bg-raised" : "border-ink/10 hover:bg-ink/[0.04]")}>
            <InstanceProviderMark instance={instance} size={20} />
            <span className="text-[13px] leading-[18px] text-ink">{engineDisplayName(instance)}</span>
            <span className="text-[11px] leading-[14px] text-ink-secondary">{line(instance)}</span>
          </button>
        );
      })}
    </div>
  );
}
