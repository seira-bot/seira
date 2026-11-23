import { Info } from "lucide-react";

/** A turn that ran without the place it was set to: a quiet note with the one way on, never an error and never Retry. */
export function PlaceNoteRow({ message, action }: { message: string; action: { label: string; onClick: () => void } | null }) {
  return (
    <div role="note" data-place-note="" className="flex justify-start">
      <div className="w-fit max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))] rounded-xl border border-hairline/60 bg-raised/50 px-3.5 py-2.5 text-[14px] text-ink">
        <div className="flex items-start gap-2">
          <Info size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-ink-secondary" />
          <span className="min-w-0 break-words">{message}</span>
        </div>
        {action && <button type="button" onClick={action.onClick} className="ui-button ui-button-md mt-2 rounded-full">{action.label}</button>}
      </div>
    </div>
  );
}
