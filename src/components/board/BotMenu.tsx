import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import type { Bot } from "@/state/store";
import { BotAvatar } from "../Avatar";

export interface BotMenuProps {
  label: string;
  bots: readonly Bot[];
  /** The chosen bot id; null is the extra first choice. */
  value: string | null;
  onChange: (botId: string | null) => void;
  /** The text of the extra first choice, when there is one. */
  allLabel?: string;
  summary: ReactNode;
  className?: string;
  ui?: string;
}

export function BotMenu({ label, bots, value, onChange, allLabel, summary, className, ui }: BotMenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const choices: Array<{ id: string | null; name: string; bot?: Bot }> = [
    ...(allLabel ? [{ id: null, name: allLabel }] : []),
    ...bots.map((bot) => ({ id: bot.id, name: bot.name, bot })),
  ];

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>("[aria-checked=true]")?.focus();
    const away = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const items = () => [...(root.current?.querySelectorAll<HTMLElement>("[role=menuitemradio]") ?? [])];
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); trigger.current?.focus(); return; }
    const move = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!move) return;
    event.preventDefault();
    if (!open) { setOpen(true); return; }
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    all[(at + move + all.length) % all.length]?.focus();
  };

  return (
    <div ref={root} data-ui={ui} className={cn("relative", className)} onKeyDown={onKeyDown}>
      <button ref={trigger} type="button" aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={() => setOpen((was) => !was)}
        className="flex h-8 max-w-full items-center gap-1.5 rounded-lg bg-control px-2.5 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none">
        {summary}
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-tertiary" />
      </button>
      {open && (
        <div role="menu" aria-label={label} className="absolute start-0 top-full z-20 mt-1 max-h-72 min-w-48 overflow-y-auto rounded-xl bg-menu p-1 shadow-lg ring-1 ring-hairline">
          {choices.map((choice) => (
            <button key={choice.id ?? "all"} type="button" role="menuitemradio" aria-checked={choice.id === value} tabIndex={-1}
              onClick={() => { onChange(choice.id); setOpen(false); trigger.current?.focus(); }}
              className={cn("flex h-8 w-full items-center gap-2 rounded-lg px-2 text-start text-[13px] text-ink hover:bg-menu-hover focus-visible:bg-menu-hover focus-visible:outline-none", choice.id === value && "bg-menu-active font-medium")}>
              {choice.bot && <BotAvatar bot={choice.bot} size={18} label="" />}
              <span className="min-w-0 flex-1 truncate">{choice.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
