import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { MENU_SHEET } from "../menu-recipe";

const GAP = 4;
const EDGE = 8;

/** A button that opens a small menu of rows. The menu is fixed to the window, so a scrolling lane never clips it. */
export function BoardMenu({ label, summary, ui, disabled, disabledReason, caret = true, className, triggerClass, menuClass, children, onOpenChange }: {
  label: string;
  summary: ReactNode;
  ui?: string;
  disabled?: boolean;
  /** Said as the tooltip of a disabled trigger. */
  disabledReason?: string;
  caret?: boolean;
  className?: string;
  triggerClass?: string;
  menuClass?: string;
  /** The rows. Call `close` after a choice. */
  children: (close: () => void) => ReactNode;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpenState] = useState(false);
  const [place, setPlace] = useState<CSSProperties>({});
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const setOpen = useCallback((next: boolean) => { setOpenState(next); onOpenChange?.(next); }, [onOpenChange]);
  const close = useCallback(() => { setOpen(false); trigger.current?.focus(); }, [setOpen]);

  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const box = trigger.current.getBoundingClientRect();
    const size = menu.current.getBoundingClientRect();
    const rtl = getComputedStyle(trigger.current).direction === "rtl";
    const room = window.innerWidth - EDGE;
    const left = Math.min(Math.max(EDGE, rtl ? box.right - size.width : box.left), Math.max(EDGE, room - size.width));
    const below = box.bottom + GAP;
    const top = below + size.height > window.innerHeight - EDGE ? Math.max(EDGE, box.top - GAP - size.height) : below;
    setPlace({ left, top });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const first = menu.current?.querySelector<HTMLElement>("[aria-checked=true]") ?? menu.current?.querySelector<HTMLElement>("[role^=menuitem]");
    first?.focus();
    const away = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open, setOpen]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && open) { event.stopPropagation(); close(); return; }
    const move = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!move) return;
    event.preventDefault();
    if (!open) { setOpen(true); return; }
    const all = [...(menu.current?.querySelectorAll<HTMLElement>("[role^=menuitem]:not(:disabled)") ?? [])];
    const at = all.indexOf(document.activeElement as HTMLElement);
    all[(at + move + all.length) % all.length]?.focus();
  };

  return (
    <div ref={root} data-ui={ui} className={cn("relative", className)} onKeyDown={onKeyDown}>
      <button ref={trigger} type="button" aria-haspopup="menu" aria-expanded={open} aria-label={label} disabled={disabled} title={disabled ? disabledReason : undefined}
        onClick={(event) => { event.stopPropagation(); setOpen(!open); }}
        className={cn("flex h-8 max-w-full items-center gap-1.5 rounded-full bg-control px-3 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-control focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none", triggerClass)}>
        {summary}
        {caret && <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-tertiary" />}
      </button>
      {open && (
        <div ref={menu} role="menu" aria-label={label} style={{ position: "fixed", ...place }} className={cn("z-50 max-h-[min(24rem,70vh)] w-72 max-w-[calc(100vw-16px)] overflow-y-auto", MENU_SHEET, menuClass)}>
          {children(close)}
        </div>
      )}
    </div>
  );
}

export const BOARD_MENU_ROW = "flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-start text-[13px] text-ink hover:bg-ink/[0.06] focus-visible:bg-ink/[0.06] focus-visible:outline-none disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent";
