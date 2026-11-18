import { ChevronLeft, ChevronRight } from "lucide-react";
import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";

export function VersionSwitch({ index, versions, busy, onSwitch }: {
  index: number;
  versions: readonly Message[];
  busy: boolean;
  onSwitch: (version: Message | undefined) => void;
}) {
  if (versions.length < 2) return null;
  return (
    <div className="mt-1 flex items-center gap-0.5 pr-1 text-[12px] text-ink-secondary">
      <button
        onClick={() => onSwitch(versions[index - 1])}
        disabled={index <= 0 || busy}
        className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
        title={t("chat.previousVersion")}
      >
        <ChevronLeft size={14} />
      </button>
      <span className="tabular-nums">
        {index + 1}/{versions.length}
      </span>
      <button
        onClick={() => onSwitch(versions[index + 1])}
        disabled={index >= versions.length - 1 || busy}
        className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
        title={t("chat.nextVersion")}
      >
        <ChevronRight size={14} />
      </button>
    </div>
  );
}
