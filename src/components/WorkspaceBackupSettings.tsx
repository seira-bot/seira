import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import type { WorkspaceBackupSummary } from "../../shared/workspace-backup";
import { api, useStore } from "@/state/store";
import { intlLocale, t } from "@/lib/i18n";
import { applyWorkspaceClientState, collectWorkspaceClientState, WORKSPACE_RESTORE_MARKER } from "@/lib/workspace-backup-client";
import { uploadBackupInChunks } from "@/lib/workspace-backup-upload";
import { backupSizeText, leftOutConfirmed, readBackupSizes, sortedBackupParts, totalWithout, type WorkspaceBackupSizes } from "@/lib/workspace-backup-sizes";
import { hasAutomationItem, readDoneItems, readRestoreChecklist, writeDoneItems, type ChecklistItem, type ChecklistItemId } from "@/lib/workspace-restore-checklist";
import { LearnMore, SETTINGS_INPUT, SettingRow, SettingsField, SettingsRows, Switch } from "./SettingsPrimitives";
import { SettingsDialog } from "./settings/SettingsDialog";

/** The size report of one opening of the export form. `request` is 0 when no form is open. */
type SizesState = { request: number; sizes: WorkspaceBackupSizes | null; unavailable: boolean };
const NO_SIZES: SizesState = { request: 0, sizes: null, unavailable: false };
let sizesRequestCounter = 0;

/** `leftOut` is the part list that an export with the leave-out option puts in its summary. */
type BackupSummary = WorkspaceBackupSummary & { leftOut?: string[] };

function partLabel(part: string): string {
  switch (part) {
    case "chats": return t("backup.part.chats");
    case "memory": return t("backup.part.memory");
    case "attachments": return t("backup.part.attachments");
    case "work-folders": return t("backup.part.work-folders");
    case "other": return t("backup.part.other");
    default: return part;
  }
}

type BackupStatus = { busy: boolean; pendingRestore?: boolean; restarts?: boolean; lastRestoreId?: string; needsAction?: unknown; leftBehind?: unknown };
const buttonClass = "cursor-pointer inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink disabled:opacity-40";
const validPassword = (value: string) => value.length >= 12 && value.length <= 1024;

/** A renderer reload cannot apply a restore; the owning server must restart. A server that restarts itself (My Cloud)
 * is waited for, then the page carries on as after a reload. */
export function WorkspaceBackupRestartNotice({ onRetry, serverRestarts = false }: { onRetry?: () => void; serverRestarts?: boolean } = {}) {
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState(false);
  const [slow, setSlow] = useState(false);
  const lock = useRef(false);
  const retry = useRef(onRetry);
  retry.current = onRetry;
  useEffect(() => {
    if (!serverRestarts) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    // A restored workspace may not know this browser's session: a reload shows sign-in.
    const check = () => api("/api/workspace-backup/status", { timeoutMs: 10_000 }).then((status: BackupStatus) => status.pendingRestore === false ? "installed" : "wait",
      (cause: unknown) => cause instanceof Error && "status" in cause && cause.status === 401 ? "signedOut" : "wait").then((state) => {
      if (!alive) return;
      if (state === "wait") timer = setTimeout(check, 3_000);
      else if (state === "installed" && retry.current) retry.current();
      else window.location.reload();
    });
    timer = setTimeout(check, 3_000);
    // Keeps waiting (and keeps the restore marker), but says so when the restart takes much longer than usual.
    const slowTimer = setTimeout(() => { if (alive) setSlow(true); }, 180_000);
    return () => { alive = false; clearTimeout(timer); clearTimeout(slowTimer); };
  }, [serverRestarts]);
  if (serverRestarts) return <div role="status" className="flex max-w-lg items-center gap-3 text-[14px]">
    <Loader2 aria-hidden="true" size={15} className="shrink-0 animate-spin" />
    <div className="flex flex-col gap-2"><p>{t("backup.serverRestarting")}</p>{slow && <p>{t("backup.serverRestartSlow")}</p>}</div>
  </div>;
  const relaunch = typeof window !== "undefined" && !window.ogb?.remoteClient?.active ? window.ogb?.relaunch : undefined;
  const restart = async () => {
    if (!relaunch || lock.current || restarting) return;
    lock.current = true; setRestarting(true); setError(false);
    try {
      if (!await relaunch()) throw new Error("Restart unavailable");
    } catch {
      lock.current = false; setRestarting(false); setError(true);
    }
  };
  return <div role="status" className="flex max-w-lg flex-col gap-4 text-[14px]">
    <p>{t(relaunch ? "backup.restartDesktop" : "backup.restart")}</p>
    {relaunch && <button type="button" className={`${buttonClass} self-start`} disabled={restarting} onClick={() => void restart()}>{restarting ? t("settings.updates.restartingShort") : t("backup.restartAction")}</button>}
    {!relaunch && onRetry && <button type="button" className={`${buttonClass} self-start`} onClick={onRetry}>{t("connectors.action.retry")}</button>}
    {error && <p role="alert" className="text-[13px] text-danger">{t("backup.restartFailed")}</p>}
  </div>;
}

export function WorkspaceBackupSummaryView({ summary }: { summary: BackupSummary }) {
  return <div className="rounded-[12px] border-[0.5px] border-(--settings-edge) bg-menu p-3">
    <h3 className="text-[14px] font-medium text-ink">{t("backup.preview")}</h3>
    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px]">
      <dt className="text-ink-secondary">{t("backup.date")}</dt><dd className="break-words text-ink">{new Date(summary.createdAt).toLocaleString(intlLocale())}</dd>
      <dt className="text-ink-secondary">{t("backup.version")}</dt><dd className="text-ink">{summary.appVersion}</dd>
      <dt className="text-ink-secondary">{t("backup.bots")}</dt><dd className="text-ink">{summary.bots}</dd>
      <dt className="text-ink-secondary">{t("backup.groups")}</dt><dd className="text-ink">{summary.groups}</dd>
      <dt className="text-ink-secondary">{t("backup.threads")}</dt><dd className="text-ink">{summary.threads}</dd>
      <dt className="text-ink-secondary">{t("backup.messages")}</dt><dd className="text-ink">{summary.messages}</dd>
      <dt className="text-ink-secondary">{t("backup.files")}</dt><dd className="text-ink">{summary.files}</dd>
      <dt className="text-ink-secondary">{t("backup.bytes")}</dt><dd className="text-ink">{summary.bytes.toLocaleString(intlLocale())}</dd>
    </dl>
    {summary.leftOut && summary.leftOut.length > 0 && <div data-backup-left-out="" className="mt-3 text-[12px] text-warning"><p className="font-medium">{t("backup.leftOut")}</p><ul className="mt-1 list-disc space-y-1 pl-4">{summary.leftOut.map((part) => <li key={part}>{partLabel(part)}</li>)}</ul></div>}
    {summary.warnings.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-4 text-[12px] text-warning">{summary.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    {summary.exclusions.length > 0 && <div className="mt-3 text-[12px] text-ink-secondary"><p className="font-medium">{t("backup.exclusions")}</p><ul className="mt-1 list-disc space-y-1 pl-4">{summary.exclusions.map((exclusion, index) => <li key={index}>{exclusion}</li>)}</ul></div>}
  </div>;
}

const CHECKLIST_TEXT: Record<ChecklistItemId, { title: Parameters<typeof t>[0]; hint: Parameters<typeof t>[0]; opensAutomations: boolean }> = {
  "routines-on": { title: "backup.checklist.routinesOn", hint: "backup.checklist.routinesOnHint", opensAutomations: true },
  "webhooks-on": { title: "backup.checklist.webhooksOn", hint: "backup.checklist.webhooksOnHint", opensAutomations: true },
  "app-automations-on": { title: "backup.checklist.appAutomationsOn", hint: "backup.checklist.appAutomationsOnHint", opensAutomations: true },
  "left-behind": { title: "backup.checklist.leftBehind", hint: "backup.checklist.leftBehindHint", opensAutomations: false },
};

/** What to do after a restore. `items` is null when the server sends no list (an older server): one static line then. */
export function WorkspaceRestoreChecklist({ items, done, onToggle, onOpen }: {
  items: ChecklistItem[] | null; done: readonly string[]; onToggle: (id: ChecklistItemId) => void; onOpen: () => void;
}) {
  if (items === null) return <SettingsRows><SettingRow title={t("backup.checklist.title")} subtitle={t("backup.checklist.legacy")}>{null}</SettingRow></SettingsRows>;
  // No automation item is not proof that nothing is paused (an older restore has no list), so the warning stays.
  const unlisted = !hasAutomationItem(items)
    ? <SettingRow title={t("backup.checklist.noneListedTitle")} subtitle={t("backup.checklist.noneListed")}>
      <button type="button" className="ui-button" data-restore-open="unlisted" onClick={onOpen}>{t("backup.checklist.open")}</button>
    </SettingRow>
    : null;
  if (items.length === 0) return <SettingsRows><SettingRow title={t("backup.checklist.title")} subtitle={t("backup.checklist.subtitle")}>{null}</SettingRow>{unlisted}</SettingsRows>;
  const open = items.filter((item) => !done.includes(item.id)).length;
  return <SettingsRows>
    <SettingRow title={t("backup.checklist.title")} subtitle={open === 0 ? t("backup.checklist.allDone") : t("backup.checklist.subtitle")}>{null}</SettingRow>
    {items.map((item) => {
      const text = CHECKLIST_TEXT[item.id];
      const finished = done.includes(item.id);
      return <SettingRow key={item.id} title={t(text.title)} subtitle={t(text.hint, { count: item.count })}
        message={finished ? <span data-restore-done={item.id}>{t("backup.checklist.doneState")}</span> : undefined}>
        <span className="flex items-center gap-2">
          {text.opensAutomations && !finished && <button type="button" className="ui-button" data-restore-open={item.id} onClick={onOpen}>{t("backup.checklist.open")}</button>}
          <button type="button" className="ui-button" data-restore-toggle={item.id} onClick={() => onToggle(item.id)}>{finished ? t("backup.checklist.markUndone") : t("backup.checklist.markDone")}</button>
        </span>
      </SettingRow>;
    })}
    {unlisted}
  </SettingsRows>;
}

type BackupRows = { exportRow: ReactNode; importRow: ReactNode; checklist?: ReactNode };
const BOTH_ROWS = ({ exportRow, importRow, checklist }: BackupRows) => <><SettingsRows>{exportRow}{importRow}</SettingsRows>{checklist}</>;

/** `layout` places the two rows (a page with a section for each); one instance still owns their state and dialogs. */
export function WorkspaceBackupSettings({ layout = BOTH_ROWS }: { layout?: (rows: BackupRows) => ReactNode } = {}) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState<"export" | "preview" | "restore" | null>(null);
  const lock = useRef(false);
  const alive = useRef(true);
  const [error, setError] = useState<string | null>(null);
  const [exportPassword, setExportPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [importPassword, setImportPassword] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploadedId, setUploadedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; summary: BackupSummary } | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [download, setDownload] = useState<{ url: string; filename: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [sizesState, setSizesState] = useState<SizesState>(NO_SIZES);
  const sizes = sizesState.sizes;
  const [leaveOut, setLeaveOut] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [more, setMore] = useState(false);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [uploadFailed, setUploadFailed] = useState(false);
  const [unfinishedUpload, setUnfinishedUpload] = useState<string | null>(null);
  const [done, setDone] = useState<string[]>([]);
  const { dispatch } = useStore();
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    try {
      const result: BackupStatus = await api("/api/workspace-backup/status");
      if (alive.current) { setStatus(result); setError(null); setDone(result.lastRestoreId ? readDoneItems(result.lastRestoreId) : []); }
    } catch (cause) {
      if (alive.current) { setStatus(null); setError(cause instanceof Error ? cause.message : String(cause)); }
    }
  };
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => { alive.current = false; };
  }, []);

  const perform = async (operation: NonNullable<typeof busy>, work: () => Promise<void>) => {
    if (lock.current || !status || status.busy || status.pendingRestore) return;
    lock.current = true;
    setBusy(operation);
    setError(null);
    try { await work(); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { lock.current = false; if (alive.current) setBusy(null); }
  };

  const exportBackup = () => perform("export", async () => {
    if (!validPassword(exportPassword) || exportPassword !== confirmPassword) return;
    // A part that the person switched off must go in the request. If the server no longer lists it as one it can
    // leave out, stop with a message: a silent full export would put the files back in a backup the person trimmed.
    if (leaveOut.some((part) => !sizes?.canLeaveOut.includes(part))) throw new Error(t("backup.leaveOutUnavailable"));
    const skipped = leaveOut;
    const result: { id: string; filename: string; summary?: BackupSummary } = await api("/api/workspace-backup/export", {
      method: "POST", body: JSON.stringify({ password: exportPassword, clientState: collectWorkspaceClientState(), ...(skipped.length ? { leaveOut: skipped } : {}) }),
    });
    // HTTP success is not enough: the summary of the new backup must list every part that the person chose to leave
    // out. An older server ignores the choice, and its full backup would carry the files the person meant to keep out.
    // Stop before any download link, and keep the form and its passwords so the person can try again.
    if (!leftOutConfirmed(result.summary, skipped)) throw new Error(t("backup.leaveOutNotConfirmed"));
    if (alive.current) { setExportPassword(""); setConfirmPassword(""); }
    if (!alive.current) return;
    const url = `/api/workspace-backup/download/${encodeURIComponent(result.id)}`;
    setDownload({ url, filename: result.filename });
    const link = document.createElement("a");
    link.href = url;
    link.download = result.filename;
    document.body.append(link);
    link.click();
    link.remove();
    setExporting(false);
    setSizesState(NO_SIZES);
  });

  const previewBackup = () => perform("preview", async () => {
    if (!file || !importPassword) return;
    setPreview(null);
    setConfirmation("");
    setUploadFailed(false);
    let id = uploadedId;
    if (!id) {
      try {
        id = await uploadBackupInChunks(file, {
          api, resumeId: unfinishedUpload,
          onStarted: (started) => { if (alive.current) setUnfinishedUpload(started); },
          onProgress: (percent) => { if (alive.current) setUploadPercent(percent); },
        });
      } catch (cause) {
        if (cause instanceof Error && "status" in cause && cause.status === 404) setUnfinishedUpload(null);
        if (alive.current) { setUploadPercent(null); setUploadFailed(true); }
        throw cause;
      }
      setUnfinishedUpload(null);
      if (alive.current) { setUploadPercent(null); setUploadedId(id); }
    }
    const result: { id: string; summary: BackupSummary } = await api("/api/workspace-backup/preview", {
      method: "POST", body: JSON.stringify({ id, password: importPassword }),
    }).catch((cause: unknown) => {
      if (cause instanceof Error && "status" in cause && cause.status === 404 && alive.current) setUploadedId(null);
      throw cause;
    });
    if (alive.current) { setPreview({ id: result.id, summary: result.summary }); setUploadedId(null); setImportPassword(""); }
  });

  const restoreBackup = () => perform("restore", async () => {
    if (!preview || confirmation !== "REPLACE") return;
    // The stage ID is the restore ID: persist it before the request so a lost response still lets this browser recover
    // its drafts at boot.
    localStorage.setItem(WORKSPACE_RESTORE_MARKER, preview.id);
    let restarting = false;
    try {
      ({ restarting = false } = await api("/api/workspace-backup/restore", {
        method: "POST", body: JSON.stringify({ id: preview.id, confirmation: "REPLACE" }),
      }) as { restarting?: boolean });
    } catch (cause) {
      if (cause instanceof Error && "status" in cause && cause.status === 404 && alive.current) {
        setPreview(null); setUploadedId(null); setConfirmation("");
      }
      throw cause;
    }
    if (alive.current) { setStatus({ busy: false, pendingRestore: true, restarts: restarting }); setPreview(null); setConfirmation(""); }
  });

  const toggleDone = (id: ChecklistItemId) => {
    if (!status?.lastRestoreId) return;
    const next = done.includes(id) ? done.filter((item) => item !== id) : [...done, id];
    setDone(next);
    writeDoneItems(status.lastRestoreId, next);
  };
  const checklist = status?.lastRestoreId
    ? <WorkspaceRestoreChecklist items={readRestoreChecklist(status)} done={done} onToggle={toggleDone} onOpen={() => dispatch({ type: "showRoutines" })} />
    : null;
  const disabled = busy !== null || !status || status.busy || Boolean(status.pendingRestore);
  const closeExport = () => { setExporting(false); setExportPassword(""); setConfirmPassword(""); setLeaveOut([]); setSizesState(NO_SIZES); };
  // The size report is read-only. A server without it (older version) answers with an error: the form then works as before, with no sizes.
  // A Team Cloud answers 403: the totals would include other members' private data, so the form shows a line and no numbers.
  // Each opening of the form has its own request number, and a reply for an earlier opening is dropped.
  const openExport = () => {
    const request = ++sizesRequestCounter;
    setExporting(true); setSizesState({ request, sizes: null, unavailable: false }); setLeaveOut([]);
    void (async () => {
      let result: Pick<SizesState, "sizes" | "unavailable">;
      try { result = { sizes: readBackupSizes(await api("/api/workspace-backup/sizes")), unavailable: false }; }
      catch (cause) { result = { sizes: null, unavailable: cause instanceof Error && "status" in cause && cause.status === 403 }; }
      if (alive.current) setSizesState((current) => current.request === request ? { request, ...result } : current);
    })();
  };
  const toggleLeaveOut = (part: string) => setLeaveOut((current) => current.includes(part) ? current.filter((item) => item !== part) : [...current, part]);
  const sizeSection = () => sizesState.unavailable ? <p data-backup-sizes-unavailable="" role="status" className="text-[12px] leading-4 text-ink-secondary">{t("backup.sizes.unavailable")}</p> : sizes && <section data-backup-sizes="" className="flex flex-col gap-2 rounded-[12px] border-[0.5px] border-(--settings-edge) bg-menu p-3">
    <h3 className="text-[14px] font-medium text-ink">{t("backup.sizes.title")}</h3>
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-[13px]">
      {sortedBackupParts(sizes).map((part) => <Fragment key={part}>
        <dt className={leaveOut.includes(part) ? "text-ink-secondary line-through" : "text-ink-secondary"}>{partLabel(part)}</dt>
        <dd data-backup-size={part} className="text-right tabular-nums text-ink">{backupSizeText(sizes.parts[part])}</dd>
      </Fragment>)}
      <dt className="font-medium text-ink">{t("backup.sizes.total")}</dt>
      <dd data-backup-total="" className="text-right font-medium tabular-nums text-ink">{backupSizeText(totalWithout(sizes, leaveOut))}</dd>
    </dl>
    {sizes.canLeaveOut.map((part) => <div key={part} className="flex items-center justify-between gap-3 text-[13px] text-ink">
      <span>{t("backup.leaveOut", { part: partLabel(part).toLowerCase() })}</span>
      <Switch checked={leaveOut.includes(part)} disabled={disabled} aria-label={t("backup.leaveOut", { part: partLabel(part).toLowerCase() })} data-backup-leave-out={part} onClick={() => toggleLeaveOut(part)} />
    </div>)}
    {leaveOut.length > 0 && <p data-backup-leave-out-warning="" className="text-[12px] leading-4 text-warning">{t("backup.leaveOutWarning")}</p>}
    <p className="text-[12px] leading-4 text-ink-secondary">{t("backup.sizes.upperBound")} {t("backup.sizes.space")}</p>
  </section>;
  const closeImport = () => { setImporting(false); setFile(null); setUploadedId(null); setUnfinishedUpload(null); setUploadFailed(false); setUploadPercent(null); setPreview(null); setConfirmation(""); setImportPassword(""); };
  if (status?.pendingRestore) {
    return layout({ exportRow: null, importRow: <div className="px-4 py-3"><WorkspaceBackupRestartNotice serverRestarts={status.restarts === true} /></div> });
  }
  return <>
    {layout({
      exportRow: <SettingRow title={t("backup.export")} subtitle={<>{t("backup.exportShort")}{" "}<LearnMore onClick={() => setMore((open) => !open)} /></>}
        message={<>
          {more && <span data-backup-more="" className="flex flex-col gap-1"><span>{t("backup.scope")}</span><span>{t("backup.excluded")}</span><span>{t("backup.privacy")}</span></span>}
          {download && <a href={download.url} download={download.filename} className="break-all text-accent-text hover:underline">{t("backup.downloadAgain", { filename: download.filename })}</a>}
          {(!status || status.busy) && <span role="status">{status?.busy ? t("backup.serverBusy") : t("backup.checkStatus")}{" "}<button type="button" onClick={() => void refresh()} className="cursor-pointer text-accent-text hover:underline">{t("connectors.action.retry")}</button></span>}
          {error && <span role="alert" className="block whitespace-pre-line break-words text-danger">{error}</span>}
        </>}>
        <button type="button" className="ui-button" disabled={disabled} data-backup-export="" onClick={openExport}>{t("backup.exportAction")}</button>
      </SettingRow>,
      importRow: <SettingRow title={t("backup.import")} subtitle={t("backup.importShort")}>
        <button type="button" className="ui-button" disabled={disabled} data-backup-import="" onClick={() => setImporting(true)}>{t("backup.chooseFile")}</button>
      </SettingRow>,
      checklist,
    })}
    {exporting && (
      <SettingsDialog title={t("backup.export")} onClose={closeExport}>
        <form id="backup-export" className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void exportBackup(); }}>
          <p className="text-[13px] leading-[18px] text-ink-secondary">{t("backup.passwordHint")}</p>
          {sizeSection()}
          <SettingsField label={t("backup.exportPassword")}>
            <input type="password" autoComplete="new-password" minLength={12} maxLength={1024} required disabled={disabled} value={exportPassword} onChange={(event) => setExportPassword(event.target.value)} className={SETTINGS_INPUT} />
          </SettingsField>
          <SettingsField label={t("backup.confirmPassword")}>
            <input type="password" autoComplete="new-password" minLength={12} maxLength={1024} required disabled={disabled} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} className={SETTINGS_INPUT} />
          </SettingsField>
          {error && <p role="alert" className="whitespace-pre-line break-words text-[12px] leading-4 text-danger">{error}</p>}
          <div className="flex items-center justify-end gap-2">
            <button type="button" className="ui-button" onClick={closeExport}>{t("common.cancel")}</button>
            <button type="submit" className="ui-button ui-button-primary gap-1.5" disabled={disabled || !validPassword(exportPassword) || exportPassword !== confirmPassword}>
              {busy === "export" && <Loader2 aria-hidden="true" size={14} className="animate-spin" />}{busy === "export" ? t("backup.exporting") : t("backup.exportAction")}
            </button>
          </div>
        </form>
      </SettingsDialog>
    )}
    {importing && (
      <SettingsDialog title={t("backup.import")} onClose={closeImport}>
        <form id="backup-import" className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void previewBackup(); }}>
          <p className="text-[13px] leading-[18px] text-ink-secondary">{t("backup.importHint")}</p>
          <SettingsField label={t("backup.file")}>
            <span className="flex items-center gap-3">
              <input ref={fileInput} type="file" accept=".seirabackup,.ombbackup" className="sr-only" tabIndex={-1} disabled={disabled}
                onChange={(event) => { setFile(event.target.files?.[0] ?? null); setUploadedId(null); setUnfinishedUpload(null); setUploadFailed(false); setPreview(null); setConfirmation(""); setImportPassword(""); setError(null); }} />
              <button type="button" className="ui-button shrink-0" disabled={disabled} onClick={() => fileInput.current?.click()}>{t("backup.chooseFile")}</button>
              <span className="min-w-0 truncate text-[13px] leading-5 text-ink-secondary">{file?.name ?? t("backup.noFile")}</span>
            </span>
          </SettingsField>
          {!preview && (
            <SettingsField label={t("backup.importPassword")}>
              <input type="password" autoComplete="off" maxLength={1024} required disabled={disabled || !file} value={importPassword} onChange={(event) => setImportPassword(event.target.value)} className={SETTINGS_INPUT} />
            </SettingsField>
          )}
          {!preview && error && <p role="alert" className="break-words text-[12px] leading-4 text-danger">{error}</p>}
          {!preview && (
            <div className="flex items-center justify-end gap-2">
              <button type="button" className="ui-button" onClick={closeImport}>{t("common.cancel")}</button>
              <button type="submit" disabled={disabled || !file || !importPassword} className="ui-button ui-button-primary gap-1.5">
                {busy === "preview" && <Loader2 aria-hidden="true" size={14} className="animate-spin" />}{busy === "preview" ? (uploadPercent === null ? t("backup.validating") : t("backup.uploading", { percent: uploadPercent })) : uploadFailed ? t("connectors.action.retry") : t("backup.validate")}
              </button>
            </div>
          )}
        </form>
        {preview && <>
          <WorkspaceBackupSummaryView summary={preview.summary} />
          <p className="text-[13px] leading-[18px] text-danger">{t("backup.replaceWarning")} {t("backup.trustWarning")}</p>
          <SettingsField label={t("backup.confirmReplace")}>
            <input value={confirmation} autoComplete="off" spellCheck={false} disabled={disabled} onChange={(event) => setConfirmation(event.target.value)} className={SETTINGS_INPUT} />
          </SettingsField>
          {error && <p role="alert" className="break-words text-[12px] leading-4 text-danger">{error}</p>}
          <div className="flex items-center justify-end gap-2">
            <button type="button" className="ui-button" onClick={closeImport}>{t("common.cancel")}</button>
            <button type="button" disabled={disabled || confirmation !== "REPLACE"} onClick={() => void restoreBackup()}
              className="ui-button !bg-danger !text-danger-ink disabled:opacity-40">{busy === "restore" ? t("backup.restoring") : t("backup.replace")}</button>
          </div>
        </>}
      </SettingsDialog>
    )}
  </>;
}

function pendingRestoreId(): string | null {
  try { return localStorage.getItem(WORKSPACE_RESTORE_MARKER); } catch { return null; }
}

/** Do not mount stale composer caches before the initiating browser recovers. */
export function WorkspaceBackupRecovery({ children }: { children: ReactNode }) {
  const [restoreId] = useState(pendingRestoreId);
  const [ready, setReady] = useState(!restoreId);
  const [error, setError] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const [serverRestarts, setServerRestarts] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!restoreId) return;
    let alive = true;
    setError(null);
    void (async () => {
      const status: BackupStatus = await api("/api/workspace-backup/status");
      if (!alive) return;
      if (status.pendingRestore) { setServerRestarts(status.restarts === true); setRestartRequired(true); return; }
      if (status.lastRestoreId !== restoreId) {
        localStorage.removeItem(WORKSPACE_RESTORE_MARKER);
        setReady(true);
        return;
      }
      const result = await api("/api/workspace-backup/client-state", { method: "POST", body: JSON.stringify({ restoreId }) });
      if (!alive) return;
      applyWorkspaceClientState(result.clientState);
      localStorage.removeItem(WORKSPACE_RESTORE_MARKER);
      window.location.reload();
    })().catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { alive = false; };
  }, [restoreId, attempt]);
  if (ready) return children;
  const continueWithoutDrafts = () => {
    try {
      localStorage.removeItem(WORKSPACE_RESTORE_MARKER);
      window.location.reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <main className="flex h-dvh flex-col items-center justify-center gap-4 bg-app p-6 text-ink">
    {restartRequired ? <WorkspaceBackupRestartNotice serverRestarts={serverRestarts} onRetry={() => { setRestartRequired(false); setAttempt((value) => value + 1); }} /> : <p className="max-w-lg text-[14px]">{t("backup.recovering")}</p>}
    {error && <p role="alert" className="max-w-lg break-words text-[13px] text-danger">{error}</p>}
    {error && <button type="button" className={buttonClass} onClick={() => { setRestartRequired(false); setAttempt((value) => value + 1); }}>{t("connectors.action.retry")}</button>}
    {error && <>
      <p className="max-w-lg text-[13px] text-ink-secondary">{t("backup.skipDraftsHint")}</p>
      <button type="button" className="cursor-pointer rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[13px] font-medium text-ink" onClick={continueWithoutDrafts}>{t("backup.skipDrafts")}</button>
    </>}
  </main>;
}
