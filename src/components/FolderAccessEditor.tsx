import { useState } from "react";
import { FolderOpen } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { type DepartmentFolders, folderAccessOrNull, limitedBy, shownFolders, type FolderAccess } from "@/lib/folder-access";
import { Segmented, TrashButton } from "./bot-panel/rows";
import { Switch } from "./SettingsPrimitives";
import { inputCls } from "./bot-settings/field";

const MIDDLE_KEEP = 44;

function middle(path: string): string {
  if (path.length <= MIDDLE_KEEP) return path;
  const head = Math.ceil((MIDDLE_KEEP - 1) / 2);
  return `${path.slice(0, head)}…${path.slice(path.length - (MIDDLE_KEEP - 1 - head))}`;
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

interface Props {
  /** The folders set on this bot or department itself. */
  access: FolderAccess | null | undefined;
  /** Saves a new list and throws an Error with a sentence for the person when it is refused. */
  save: (next: FolderAccess | null) => Promise<void>;
  /** The department that also sets folders for this bot; absent when editing a department. */
  department?: { name: string; access: FolderAccess | undefined };
  /** Who the list is for, for the empty line and the hint. */
  subject: "bot" | "department";
  enforcement: DepartmentFolders["enforcement"];
  boxMissing?: DepartmentFolders["boxMissing"];
}

const INSTALL_BWRAP = "sudo apt install bubblewrap";

export function FolderAccessEditor({ access, save, department, subject, enforcement, boxMissing }: Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const canPick = Boolean(window.ogb?.pickFolder);
  const own = access ?? { limited: false, folders: [] };
  const lockedBy = department?.access?.limited ? department.name : null;
  const limited = limitedBy(access, department) !== null;
  const rows = shownFolders(access, department);
  const readOnlyFolder = rows.some((row) => !row.write);
  const boxed = enforcement === "box" || (enforcement === "limited" && limited);

  const commit = async (next: FolderAccess): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      await save(folderAccessOrNull(next));
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const add = async (raw: string) => {
    const added = raw.trim();
    if (!added) return;
    if (own.folders.some((folder) => folder.path === added)) {
      setPath("");
      return;
    }
    if (await commit({ ...own, folders: [...own.folders, { path: added, write: false }] })) setPath("");
  };
  const pick = async () => {
    const chosen = await window.ogb?.pickFolder?.();
    if (chosen) await add(chosen);
  };
  const setWrite = (target: string, write: boolean) =>
    void commit({ ...own, folders: own.folders.map((folder) => folder.path === target ? { ...folder, write } : folder) });
  const remove = (target: string) => void commit({ ...own, folders: own.folders.filter((folder) => folder.path !== target) });

  return (
    <div data-folder-access="" className="flex flex-col gap-3">
      <Segmented
        label={t("folderAccess.mode.label")}
        attr="data-folder-mode"
        value={limited ? "chosen" : "all"}
        options={[
          { value: "all", label: t("folderAccess.mode.all"), disabled: saving || lockedBy !== null },
          { value: "chosen", label: t("folderAccess.mode.chosen"), disabled: saving || lockedBy !== null },
        ]}
        onChange={(mode) => void commit({ ...own, limited: mode === "chosen" })}
      />
      {lockedBy !== null && <div className="text-[12px] text-ink-secondary">{t("folderAccess.setBy", { department: lockedBy })}</div>}
      {limited && <div className="text-[12px] text-ink-secondary">{t(subject === "bot" ? "folderAccess.hint.bot" : "folderAccess.hint.department")}</div>}

      {rows.length === 0 ? (
        <div className="text-[13px] text-ink-secondary">{t(subject === "bot" ? "folderAccess.empty.bot" : "folderAccess.empty.department")}</div>
      ) : (
        <ul aria-label={t("folderAccess.list")} className="flex flex-col divide-y divide-ink/[0.05]">
          {rows.map((row) => (
            <li key={`${row.from ?? ""}:${row.path}`} className="flex min-h-[40px] items-center gap-2.5 py-1.5">
              <span className="flex min-w-0 flex-1 flex-col">
                <span data-folder-name="" className="truncate text-[13px] text-ink">{folderName(row.path)}</span>
                <span title={row.path} className="truncate font-mono text-[11px] text-ink-secondary">{middle(row.path)}</span>
              </span>
              {row.from !== undefined && <span className="ui-chip shrink-0">{t("folderAccess.from", { department: row.from })}</span>}
              <span className="shrink-0 text-[12px] text-ink-secondary">{t("folderAccess.canChange")}</span>
              <Switch
                checked={row.write}
                aria-label={t("folderAccess.canChangeFor", { path: row.path })}
                title={row.from !== undefined ? t("folderAccess.setBy", { department: row.from }) : undefined}
                disabled={saving || row.from !== undefined}
                onClick={() => setWrite(row.path, !row.write)}
              />
              {row.from === undefined
                ? <TrashButton label={t("folderAccess.remove", { path: row.path })} disabled={saving} onClick={() => remove(row.path)} />
                : <span aria-hidden="true" className="size-7 shrink-0" />}
            </li>
          ))}
        </ul>
      )}

      {canPick ? (
        <div>
          <button type="button" disabled={saving} onClick={() => void pick()} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-control px-3 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            <FolderOpen size={14} aria-hidden="true" /> {t("folderAccess.add.pick")}
          </button>
        </div>
      ) : (
        <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); void add(path); }}>
          <input
            className={cn(inputCls, "font-mono text-[13px]")}
            aria-label={t("folderAccess.add.pathLabel")}
            placeholder={t("folderAccess.add.pathPlaceholder")}
            value={path}
            disabled={saving}
            onChange={(event) => setPath(event.target.value)}
          />
          <button type="submit" disabled={saving || !path.trim()} className="shrink-0 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            {t("common.add")}
          </button>
        </form>
      )}

      {department?.access && (department.access.folders.length > 0 || department.access.limited) && (
        <div className="text-[12px] text-ink-secondary">{t("folderAccess.combine", { department: department.name })}</div>
      )}
      {error && <div role="alert" className="text-[12px] text-danger">{error}</div>}
      {!boxed && (limited || readOnlyFolder) && (
        <div className="text-[12px] text-ink-secondary">{t("folderAccess.aiNote", { approval: t("approvalMode.ask.label") })}</div>
      )}
      {!boxed && (limited || readOnlyFolder) && boxMissing === "no-bwrap" && (
        <div className="text-[12px] text-ink-secondary">
          <div>{t("folderAccess.noBwrap")}</div>
          <code dir="ltr" className="mt-1 block select-all rounded-md bg-control px-2 py-1 text-ink">{INSTALL_BWRAP}</code>
        </div>
      )}
      {enforcement === "limited" && limited && (
        <div className="text-[12px] text-ink-secondary">{t("folderAccess.boxNote")}</div>
      )}
    </div>
  );
}
