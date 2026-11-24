import { FolderOpen, Loader2, Upload } from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { droppedFiles, pickedFiles, type DroppedFile } from "@/lib/ai-import";

export interface DropZoneProps {
  /** Set while files go up. */
  sending: { done: number; total: number } | null;
  failed?: boolean;
  onFiles: (files: DroppedFile[]) => void;
}

const isBackup = (file: DroppedFile) => file.name.toLowerCase().endsWith(".seirabackup");

export function DropZone({ sending, failed = false, onFiles }: DropZoneProps) {
  const [over, setOver] = useState(false);
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const [backup, setBackup] = useState(false);
  const busy = sending !== null;
  const take = (all: DroppedFile[]) => {
    const rest = all.filter((file) => !isBackup(file));
    setBackup(rest.length < all.length);
    if (rest.length > 0) onFiles(rest);
  };
  const pick = (list: FileList | null) => {
    if (list && list.length > 0) take(pickedFiles(list));
  };
  return (
    <div data-ai-import-drop="" className="flex flex-col gap-2">
      <div
        onDragOver={(event) => { event.preventDefault(); if (!busy) setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          if (!busy) void droppedFiles(event.dataTransfer).then((dropped) => { if (dropped.length > 0) take(dropped); });
        }}
        className={cn("flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-6 text-center transition-colors", over ? "border-accent bg-accent/[0.06]" : "border-ink/15")}
      >
        {busy ? <Loader2 size={16} className="animate-spin text-ink-secondary" aria-hidden="true" /> : <Upload size={16} className="text-ink-secondary" aria-hidden="true" />}
        <div className="flex flex-col gap-0.5">
          <span className="text-[13px] font-medium text-ink">{busy ? t("aiImport.drop.sending", { done: sending.done, total: sending.total }) : t("aiImport.drop.title")}</span>
          <span className="text-[12px] leading-4 text-ink-tertiary">{t("aiImport.drop.hint")}</span>
        </div>
        <div className="flex gap-2">
          <button type="button" data-ai-import-files="" className="ui-button gap-1.5" disabled={busy} onClick={() => files.current?.click()}>
            <Upload size={14} aria-hidden="true" />{t("aiImport.drop.files")}
          </button>
          <button type="button" data-ai-import-folder="" className="ui-button gap-1.5" disabled={busy} onClick={() => folder.current?.click()}>
            <FolderOpen size={14} aria-hidden="true" />{t("aiImport.drop.folder")}
          </button>
        </div>
        <input ref={files} type="file" multiple hidden tabIndex={-1} onChange={(event) => { pick(event.target.files); event.target.value = ""; }} />
        <input ref={folder} type="file" hidden tabIndex={-1} {...{ webkitdirectory: "" }} onChange={(event) => { pick(event.target.files); event.target.value = ""; }} />
      </div>
      {backup && <p role="status" data-ai-import-backup="" className="text-[12px] leading-4 text-ink-secondary">{t("aiImport.drop.backup")}</p>}
      {failed && <p role="alert" className="text-[12px] leading-4 text-danger">{t("aiImport.drop.failed")}</p>}
    </div>
  );
}
