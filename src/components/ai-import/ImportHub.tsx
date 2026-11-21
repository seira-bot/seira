// Settings → Import & export → Move from another AI. Views take plain props so tests can draw every screen;
// ImportHubSection holds the state.
import { Bot, ClipboardPaste } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { aiImportApi, uploadAll, type AiImportClient, type DroppedFile } from "@/lib/ai-import";
import { copyText } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { useStore } from "@/state/store";
import type { ApplyImportJob, ImportDestination, ImportErrorCode, ImportJobView, LocalSourceView, PasteSource } from "../../../shared/ai-import/api";
import type { ImportSourceKind } from "../../../shared/ai-import/bundle";
import { parsePaste, pastePrompt } from "../../../shared/ai-import/paste";
import { GrokBotMark } from "../GrokBotMark";
import { ClaudeMark, HermesMark, PresetProviderMark } from "../ProviderIcons";
import { SettingRow, SettingsMark } from "../SettingsPrimitives";
import { GrokMoveDialog } from "../lazy-screens";
import { sourceName } from "./copy";
import { DropZone } from "./DropZone";
import { ImportError } from "./Errors";
import { PasteStep } from "./PasteStep";
import { ApplyView, ReadingView } from "./Progress";
import { ReportView } from "./Report";
import { chosenDestination, ReviewView, type BotChoice } from "./Review";

export type GuideSource = "chatgpt" | "claude-ai";
const LOCAL_KINDS: ReadonlySet<ImportSourceKind> = new Set(["hermes", "openclaw", "claude-code"]);

export function SourceMark({ kind, size = 18 }: { kind: ImportSourceKind | "grok-bot"; size?: number }): ReactNode {
  switch (kind) {
    case "chatgpt": return <PresetProviderMark preset="openai" size={size} />;
    case "claude-ai":
    case "claude-code": return <ClaudeMark size={size} />;
    case "hermes": return <HermesMark size={size} />;
    case "grok-bot": return <GrokBotMark size={size} />;
    case "paste": return <ClipboardPaste size={size} aria-hidden="true" />;
    default: return <Bot size={size} aria-hidden="true" />;
  }
}

const isActive = (job: ImportJobView) => job.state === "queued" || job.state === "reading" || job.state === "ready" || job.state === "applying";
/** The job the hub offers to come back to: one in progress, else the latest that can still be undone. */
export function resumableJob(jobs: readonly ImportJobView[], now: number): ImportJobView | null {
  const sorted = [...jobs].sort((a, b) => b.updatedAt - a.updatedAt);
  return sorted.find(isActive) ?? sorted.find((job) => job.undoUntil !== null && job.undoUntil > now && job.state !== "undone" && job.report !== null) ?? null;
}

export interface HubViewProps {
  /** The server runs on this computer. */
  local: boolean;
  /** undefined while looking; null when the look failed. */
  localSources: readonly LocalSourceView[] | null | undefined;
  transcripts: boolean;
  grokOpen: boolean;
  /** The Grok Bot dialog, drawn under its row while open. */
  grokDialog?: ReactNode;
  resume: ImportJobView | null;
  sending: { done: number; total: number } | null;
  sendFailed?: boolean;
  onTranscripts: (on: boolean) => void;
  onGuide: (source: GuideSource) => void;
  onBring: (source: LocalSourceView) => void;
  onPaste: () => void;
  onGrok: () => void;
  onResume: (job: ImportJobView) => void;
  onFiles: (files: DroppedFile[]) => void;
}

function SourceRow({ kind, title, line, action, onAction, extra }: { kind: ImportSourceKind | "grok-bot"; title?: string; line: string; action: string; onAction: () => void; extra?: ReactNode }) {
  return (
    <SettingRow title={title ?? sourceName(kind)} subtitle={line} leading={<SettingsMark><SourceMark kind={kind} /></SettingsMark>} message={extra}>
      <button type="button" data-ai-import-source={kind} className="ui-button" onClick={onAction}>{action}</button>
    </SettingRow>
  );
}

export function HubView(props: HubViewProps) {
  const { local, localSources, transcripts, grokOpen, grokDialog, resume, sending, sendFailed, onTranscripts, onGuide, onBring, onPaste, onGrok, onResume, onFiles } = props;
  const found = (localSources ?? []).filter((source) => LOCAL_KINDS.has(source.kind));
  return (
    <div data-import-section="ai-import" data-settings-block="ai-import" className="contents">
      <SettingRow title={t("aiImport.title")} subtitle={t("aiImport.subtitle")}>{null}</SettingRow>
      {resume && (
        <SettingRow title={t(isActive(resume) ? "aiImport.running.title" : "aiImport.last.title")}>
          <button type="button" data-ai-import-resume="" className="ui-button" onClick={() => onResume(resume)}>{t(isActive(resume) ? "aiImport.running.view" : "aiImport.last.view")}</button>
        </SettingRow>
      )}
      {local ? (
        <>
          {found.map((source) => (
            <SourceRow key={source.id} kind={source.kind} title={source.name} line={t(`aiImport.line.${source.kind}` as LocaleKey)} action={t("aiImport.action.bringIn")} onAction={() => onBring(source)}
              extra={source.kind === "claude-code" ? (
                <label className="inline-flex items-center gap-2 text-[12px] leading-4 text-ink-secondary">
                  <input type="checkbox" data-ai-import-transcripts="" checked={transcripts} onChange={(event) => onTranscripts(event.target.checked)} className="size-3.5 accent-[var(--color-accent)]" />
                  {t("aiImport.transcripts")}
                </label>
              ) : undefined} />
          ))}
          {localSources === undefined && <SettingRow title={t("aiImport.group.here")} subtitle={t("aiImport.looking")}>{null}</SettingRow>}
          {localSources !== undefined && found.length === 0 && <SettingRow title={t("aiImport.group.here")} subtitle={t("aiImport.nothingHere")}>{null}</SettingRow>}
        </>
      ) : (
        <SettingRow title={t("aiImport.group.here")} subtitle={t("aiImport.remoteNote")}>{null}</SettingRow>
      )}
      <SourceRow kind="chatgpt" line={t("aiImport.line.chatgpt")} action={t("aiImport.action.choose")} onAction={() => onGuide("chatgpt")} />
      <SourceRow kind="claude-ai" line={t("aiImport.line.claude-ai")} action={t("aiImport.action.choose")} onAction={() => onGuide("claude-ai")} />
      <div data-settings-block="grok-move" className="flex flex-col">
        <SettingRow title={sourceName("grok-bot")} subtitle={t("settings.import.grokLine")} leading={<SettingsMark><SourceMark kind="grok-bot" /></SettingsMark>}>
          <button type="button" className="ui-button" data-grok-move-open aria-expanded={grokOpen} onClick={onGrok}>{t(grokOpen ? "common.close" : "settings.import.moveAction")}</button>
        </SettingRow>
        {grokOpen && grokDialog && <div className="px-4 pb-3">{grokDialog}</div>}
      </div>
      <SourceRow kind="paste" line={t("aiImport.line.paste")} action={t("aiImport.action.paste")} onAction={onPaste} />
      <div className="px-4 py-3"><DropZone sending={sending} failed={sendFailed} onFiles={onFiles} /></div>
    </div>
  );
}

export function GuideView({ source, sending, failed, onFiles, onBack }: { source: GuideSource; sending: HubViewProps["sending"]; failed?: boolean; onFiles: (files: DroppedFile[]) => void; onBack: () => void }) {
  return (
    <div data-ai-import-screen="guide" className="flex flex-col gap-4">
      <h3 className="text-[14px] font-medium text-ink">{t("aiImport.guide.title", { source: sourceName(source) })}</h3>
      <ol className="flex list-decimal flex-col gap-1.5 ps-5 text-[13px] leading-[18px] text-ink">
        {[1, 2, 3].map((step) => <li key={step}>{t(`aiImport.guide.${source}.${step}` as LocaleKey)}</li>)}
      </ol>
      <DropZone sending={sending} failed={failed} onFiles={onFiles} />
      <div><button type="button" data-ai-import-back="" className="ui-button" disabled={sending !== null} onClick={onBack}>{t("aiImport.back")}</button></div>
    </div>
  );
}

type Screen =
  | { name: "hub" }
  | { name: "guide"; source: GuideSource }
  | { name: "paste" }
  | { name: "job"; id: string }
  | { name: "error"; code: ImportErrorCode | null };

const POLL_MS = 3_000;

export function ImportHubSection({ client = aiImportApi, local }: { client?: AiImportClient; local: boolean }) {
  const { state } = useStore();
  const bots = useMemo<BotChoice[]>(() => (state.bots ?? []).map((bot) => ({ id: bot.id, name: bot.name })), [state.bots]);
  const [screen, setScreen] = useState<Screen>({ name: "hub" });
  const [jobs, setJobs] = useState<Record<string, ImportJobView>>({});
  const [localSources, setLocalSources] = useState<LocalSourceView[] | null | undefined>(local ? undefined : []);
  const [transcripts, setTranscripts] = useState(false);
  const [grokOpen, setGrokOpen] = useState(false);
  const [sending, setSending] = useState<{ done: number; total: number } | null>(null);
  const [sendFailed, setSendFailed] = useState(false);
  const [choices, setChoices] = useState<Record<string, ImportDestination>>({});
  const [busy, setBusy] = useState(false);
  const [undoFailed, setUndoFailed] = useState(false);
  const [paste, setPaste] = useState<{ ai: PasteSource; text: string; destination: ImportDestination; copied: boolean }>({ ai: "chatgpt", text: "", destination: { kind: "new" }, copied: false });
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const remember = useCallback((job: ImportJobView) => setJobs((all) => (all[job.id] && all[job.id]!.updatedAt > job.updatedAt ? all : { ...all, [job.id]: job })), []);
  const openJob = useCallback((job: ImportJobView) => { remember(job); setScreen({ name: "job", id: job.id }); }, [remember]);
  const jobId = screen.name === "job" ? screen.id : null;

  useEffect(() => {
    const controller = new AbortController();
    client.list(controller.signal).then((all) => all.forEach(remember), () => {});
    if (local) client.localSources(controller.signal).then(setLocalSources, () => setLocalSources(null));
    return () => controller.abort();
  }, [client, local, remember]);

  useEffect(() => client.subscribe(remember, () => { if (jobId) void client.get(jobId).then(remember, () => {}); }), [client, remember, jobId]);

  const current = jobId ? jobs[jobId] : undefined;
  const live = current !== undefined && (current.state === "queued" || current.state === "reading" || current.state === "applying");
  useEffect(() => {
    if (!jobId || (current && !live)) return;
    const timer = setInterval(() => void client.get(jobId).then(remember, () => {}), POLL_MS);
    return () => clearInterval(timer);
  }, [client, jobId, live, current, remember]);

  const guard = async (work: () => Promise<void>, fail: () => void) => {
    try { await work(); } catch { if (alive.current) fail(); }
  };

  const sendFiles = (files: DroppedFile[]) => void guard(async () => {
    setSendFailed(false);
    setSending({ done: 0, total: files.length });
    try {
      const ids = await uploadAll(client, files, (done, total) => alive.current && setSending({ done, total }));
      openJob(await client.create({ from: "upload", uploadIds: ids }));
    } finally {
      if (alive.current) setSending(null);
    }
  }, () => setSendFailed(true));

  const destinations = (job: ImportJobView): ApplyImportJob["destinations"] =>
    Object.fromEntries(job.agents.map((agent) => [agent.ref, chosenDestination(agent, choices)]));

  const run = (work: () => Promise<ImportJobView>, fail: () => void = () => setScreen({ name: "error", code: null })) => void guard(async () => {
    setBusy(true);
    try { remember(await work()); } finally { if (alive.current) setBusy(false); }
  }, fail);

  const backToHub = () => { setScreen({ name: "hub" }); setChoices({}); setUndoFailed(false); };

  if (screen.name === "error") return <Panel><ImportError code={screen.code} onBack={backToHub} /></Panel>;
  if (screen.name === "guide") return <Panel><GuideView source={screen.source} sending={sending} failed={sendFailed} onFiles={sendFiles} onBack={backToHub} /></Panel>;
  if (screen.name === "paste") {
    return (
      <Panel>
        <PasteStep ai={paste.ai} text={paste.text} destination={paste.destination} bots={bots} copied={paste.copied} busy={busy}
          onAi={(ai) => setPaste((was) => ({ ...was, ai, copied: false }))}
          onText={(text) => setPaste((was) => ({ ...was, text }))}
          onDestination={(destination) => setPaste((was) => ({ ...was, destination }))}
          onCopy={() => void copyText(pastePrompt(paste.ai)).then((result) => { if (result === "copied") setPaste((was) => ({ ...was, copied: true })); })}
          onImport={() => {
            const { aboutYou, howToReply } = parsePaste(paste.text);
            run(() => client.create({ from: "paste", ai: paste.ai, aboutYou, howToReply, destination: paste.destination }).then((job) => { openJob(job); return job; }));
          }}
          onBack={backToHub} />
      </Panel>
    );
  }
  if (screen.name === "job") {
    if (!current) return <Panel><ReadingView job={placeholderJob(screen.id)} onCancel={backToHub} /></Panel>;
    const cancel = () => run(() => client.cancel(current.id));
    switch (current.state) {
      case "queued":
      case "reading": return <Panel><ReadingView job={current} onCancel={cancel} /></Panel>;
      case "ready": return (
        <Panel>
          <ReviewView job={current} bots={bots} choices={choices} busy={busy} onChoose={(ref, destination) => setChoices((was) => ({ ...was, [ref]: destination }))}
            onImport={() => run(() => client.apply(current.id, { destinations: destinations(current) }))} onCancel={() => { cancel(); backToHub(); }} />
        </Panel>
      );
      case "applying": return <Panel><ApplyView job={current} onStop={cancel} /></Panel>;
      default: return (
        <Panel>
          <ReportView job={current} undoing={busy} undoFailed={undoFailed} onDone={backToHub}
            onUndo={() => { setUndoFailed(false); run(() => client.undo(current.id), () => setUndoFailed(true)); }}
            onRetry={() => run(() => client.apply(current.id, { destinations: destinations(current) }))} />
        </Panel>
      );
    }
  }
  return (
    <HubView local={local} localSources={localSources} transcripts={transcripts} grokOpen={grokOpen} resume={resumableJob(Object.values(jobs), Date.now())}
      grokDialog={grokOpen ? <GrokMoveDialog inline onClose={() => setGrokOpen(false)} /> : undefined}
      sending={sending} sendFailed={sendFailed}
      onTranscripts={setTranscripts} onGuide={(source) => { setSendFailed(false); setScreen({ name: "guide", source }); }}
      onBring={(source) => run(() => client.create({ from: "local", sourceId: source.id, ...(source.kind === "claude-code" ? { transcripts } : {}) }).then((job) => { openJob(job); return job; }))}
      onPaste={() => setScreen({ name: "paste" })} onGrok={() => setGrokOpen((open) => !open)}
      onResume={openJob} onFiles={sendFiles} />
  );
}

function Panel({ children }: { children: ReactNode }) {
  return <div data-import-section="ai-import" className="flex flex-col gap-3 px-4 py-3">{children}</div>;
}

function placeholderJob(id: string): ImportJobView {
  return {
    id, source: { kind: "paste" }, state: "queued", createdAt: 0, updatedAt: 0, progress: { done: 0, total: null, unit: "items" },
    counts: { conversations: 0, messages: 0, memories: 0, topics: 0, skills: 0, tools: 0, routines: 0, channels: 0, attachments: 0, leftovers: 0 },
    agents: [], report: null, undoUntil: null, undoResult: null, error: null,
  };
}
