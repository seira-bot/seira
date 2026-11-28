import { Check, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { MoveToastState } from "./useCalendarMove";

export function MoveToast({ toast, onDismiss }: { toast: MoveToastState; onDismiss: () => void }) {
  return (
    <div role="status" data-move-toast="" className="absolute bottom-5 left-1/2 z-[6] flex -translate-x-1/2 items-center gap-2.5 whitespace-nowrap rounded-xl border border-hairline/50 bg-raised py-1.5 pl-3.5 pr-1.5 text-[13px] leading-[18px] text-ink shadow-xl">
      {toast.failed ? <X size={14} aria-hidden="true" className="text-danger" /> : <Check size={14} aria-hidden="true" className="text-success" />}
      <span className={cn("max-w-[60vw] truncate")}>{toast.message}</span>
      {toast.undo && <button type="button" onClick={toast.undo} disabled={toast.undoing} className="rounded-lg bg-control px-2.5 py-1 text-[13px] font-medium hover:bg-raised-hover disabled:opacity-50">{t("automations.cal.undo")}</button>}
      <button type="button" onClick={onDismiss} aria-label={t("automations.cal.dismiss")} className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised-hover hover:text-ink"><X size={14} /></button>
    </div>
  );
}
