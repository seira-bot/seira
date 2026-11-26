import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

import { t } from "@/lib/i18n";

/** The pop-up of "Which bots can use X?": a scrim, a title, the rows and one button. */
export function GrantDialog({ slug, title, onDismiss, note, children, action }: {
  slug: string;
  title: string;
  onDismiss: () => void;
  note?: ReactNode;
  children: ReactNode;
  action: ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cardRef.current?.focus();
    // In the capture phase, so the Apps pop-up behind this neither closes on Escape nor pulls Tab back to itself.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
      } else if (event.key === "Tab") {
        event.stopPropagation();
        const controls = cardRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])");
        const first = controls?.[0], last = controls?.[controls.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && (document.activeElement === first || document.activeElement === cardRef.current)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      opener?.focus();
    };
  }, [onDismiss]);

  return (
    <div
      data-app-grant-prompt={slug}
      className="absolute inset-0 z-10 flex items-center justify-center bg-black/55 p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onDismiss()}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-grant-title"
        tabIndex={-1}
        className="flex max-h-full w-full max-w-[360px] flex-col rounded-2xl border border-hairline/50 bg-panel p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <h3 id="app-grant-title" className="min-w-0 text-[15px] font-semibold text-ink">{title}</h3>
          <button type="button" aria-label={t("common.close")} onClick={onDismiss} className="-mt-1 -me-1 flex size-7 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink">
            <X size={16} />
          </button>
        </div>
        {note && <p className="mt-2 text-[13px] leading-snug text-ink-secondary">{note}</p>}
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto">{children}</div>
        <div className="mt-4 flex justify-end">{action}</div>
      </div>
    </div>
  );
}
