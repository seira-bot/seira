import { useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { t } from "@/lib/i18n";
import { useDepartmentFolders } from "@/lib/folder-access";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { FolderAccessEditor } from "./FolderAccessEditor";

/** The folders every bot of a department may use, for an admin. */
export function SectionFoldersDialog({ section, label, onClose }: { section: string; label: string; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const { data, setDepartment } = useDepartmentFolders(true);
  useModalDialog(dialog, onClose);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="section-folders-title" tabIndex={-1}
        className="max-h-[90vh] w-full max-w-[520px] overflow-y-auto rounded-2xl border border-hairline/50 bg-panel p-5 text-ink shadow-2xl outline-none">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id="section-folders-title" className="text-[17px] font-semibold">{t("team.foldersFor", { name: label })}</h2>
          <button aria-label={t("team.closeDialog")} onClick={onClose} className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised"><X size={18} /></button>
        </div>
        <p className="mb-3 text-[13px] leading-relaxed text-ink-secondary">{t("folderAccess.department.description")}</p>
        {data === null ? null : data.setHere ? (
          <div className="rounded-xl bg-card p-4" data-testid="section-folders">
            <FolderAccessEditor
              subject="department"
              enforcement={data.enforcement}
              boxMissing={data.boxMissing}
              access={data.departments[section]}
              save={(next) => setDepartment(section, next)}
            />
          </div>
        ) : (
          <p className="text-[13px] text-ink-secondary">{t("folderAccess.setElsewhere")}</p>
        )}
      </div>
    </div>,
    document.body,
  );
}
