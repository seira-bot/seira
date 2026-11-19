import { Check, ChevronDown, Copy, ExternalLink, FileUp, Loader2 } from "lucide-react";
import { useId, useRef, type ReactNode } from "react";

import { openExternalLink } from "@/lib/app-links";
import { cn } from "@/lib/cn";
import { useCopyFeedback } from "@/lib/copy-text";
import { isSeiraMigrator, rosterMatches, SEIRA_GROK_TEMPLATE_URL, type foundExports, type GrokLook } from "@/lib/grok-move";
import { t } from "@/lib/i18n";
import { GROK_EXPORT_PROMPT, type GrokBot } from "../../shared/grok-import";

const PRIMARY = "ui-button ui-button-primary min-h-9 px-4 text-[14px]";
const SECONDARY = "ui-button min-h-9 px-4 text-[14px]";
const LINE = "text-[13px] leading-relaxed text-ink-secondary";

type StepState = "done" | "active" | "waiting";

function Step({ id, number, state, title, children }: { id: string; number: number; state: StepState; title: string; children: ReactNode }) {
  return (
    <li data-grok-move-step={id} data-state={state} className="flex gap-3">
      <span aria-hidden className={cn(
        "mt-px flex size-6 shrink-0 items-center justify-center rounded-full border text-[12px] font-medium tabular-nums",
        state === "done" ? "border-accent bg-accent text-accent-ink" : state === "active" ? "border-accent text-accent-text" : "border-hairline text-ink-tertiary",
      )}>
        {state === "done" ? <Check size={14} /> : number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
        <h3 className={cn("text-[14px] font-medium", state === "waiting" ? "text-ink-tertiary" : "text-ink")}>
          {title}
          {state === "done" && <span className="sr-only"> {t("grokMove.guide.done")}</span>}
        </h3>
        {children}
      </div>
    </li>
  );
}

function Roster({ names, arrived = [] }: { names: readonly string[]; arrived?: readonly GrokBot[] }) {
  if (names.length === 0) return null;
  return (
    <ul data-grok-move-roster aria-label={t("grokMove.guide.rosterLabel")} className="flex flex-wrap gap-1.5">
      {names.map((name) => {
        const here = arrived.some((bot) => rosterMatches(name, bot.name));
        return (
          <li key={name} {...(here ? { "data-arrived": "true" } : {})} className={cn("ui-chip max-w-full", here ? "bg-accent/[0.12] text-ink" : "bg-ink/[0.06] text-ink-secondary")}>
            {here && <Check size={13} aria-hidden className="shrink-0 text-accent-text" />}
            <span title={name} dir="auto" className="truncate">{name}</span>
            {here && <span className="sr-only">{t("grokMove.guide.arrived")}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function CopyButton({ text, label, attribute }: { text: string; label: string; attribute: string }) {
  const { state, copy } = useCopyFeedback(text);
  return (
    <button type="button" {...{ [attribute]: "" }} onClick={copy} className={cn(SECONDARY, "inline-flex items-center gap-2")}>
      {state === "copied" ? <Check size={15} /> : <Copy size={15} />}
      {state === "copied" ? t("grokMove.copied") : state === "failed" ? t("grokMove.copyFailed") : label}
    </button>
  );
}

function ManualPath({ roster, reply, error, onReply, onFile }: {
  roster: readonly string[]; reply: string; error: string; onReply: (reply: string) => void; onFile: (file: File | undefined) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col items-start gap-1.5">
        <h3 className="text-[14px] font-medium text-ink">{t("grokMove.step1")}</h3>
        <p className={LINE}>{t("grokMove.step1Hint")}</p>
        <Roster names={roster} />
        <div className="mt-1"><CopyButton text={GROK_EXPORT_PROMPT} label={t("grokMove.copy")} attribute="data-grok-move-copy" /></div>
      </section>
      <section className="flex flex-col gap-1.5">
        <h3 className="text-[14px] font-medium text-ink">{t("grokMove.step2")}</h3>
        <p className={LINE}>{t("grokMove.step2Hint")}</p>
        <textarea value={reply} onChange={(event) => onReply(event.target.value)} rows={4}
          aria-label={t("grokMove.replyLabel")} placeholder={t("grokMove.replyPlaceholder")}
          className="mt-1 w-full resize-y rounded-xl border border-hairline/40 bg-inset px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none" />
        {error && <p role="alert" className="text-[13px] leading-relaxed text-danger">{error}</p>}
        <div>
          <button type="button" onClick={() => picker.current?.click()} className={cn(SECONDARY, "inline-flex items-center gap-2")}><FileUp size={15} />{t("grokMove.chooseFile")}</button>
          <input ref={picker} type="file" accept=".json,.md,.txt,application/json,text/plain,text/markdown" className="hidden" onChange={(event) => { onFile(event.target.files?.[0]); event.target.value = ""; }} />
        </div>
      </section>
    </div>
  );
}

export interface GrokMoveStartProps {
  local: boolean;
  /** The link path is on offer: this computer can make a link. */
  linkAvailable: boolean;
  url: string | undefined;
  stopped: boolean;
  connecting: boolean;
  connectFailed: boolean;
  onConnect: () => void;
  look: GrokLook;
  found: ReturnType<typeof foundExports>;
  arrived: readonly GrokBot[];
  reply: string;
  error: string;
  manualOpen: boolean;
  onManualToggle: () => void;
  onReply: (reply: string) => void;
  onFile: (file: File | undefined) => void;
  onFound: () => void;
}

export function GrokMoveStart(props: GrokMoveStartProps) {
  const { local, linkAvailable, url, stopped, connecting, connectFailed, onConnect, look, found, arrived, reply, error, manualOpen, onManualToggle, onReply, onFile, onFound } = props;
  const panel = useId();
  const roster = local ? look.bots.filter((name) => !isSeiraMigrator(name)) : [];
  const migratorHere = local && look.bots.some(isSeiraMigrator);
  const gotArrived = arrived.length > 0;
  const message = url ? t("grokMove.guide.sendMessage", { url }) : "";
  const { state: linkCopied, copy: copyLink } = useCopyFeedback(url ?? "");

  const banner = (
    <>
      {found.bots.length > 0 && (
        <div data-grok-move-found className="flex items-center justify-between gap-3 rounded-xl border border-accent/40 bg-accent/[0.06] px-3 py-2">
          <span className="min-w-0 break-words text-[13px] text-ink">{t("grokMove.found", { names: found.bots.map((bot) => bot.name).join(", ") })}</span>
          <button type="button" data-grok-move-use-found onClick={onFound} className={cn(PRIMARY, "shrink-0")}>{t("grokMove.useFound")}</button>
        </div>
      )}
      {found.refused.map((item) => <p key={item.file} role="alert" className="text-[13px] leading-relaxed text-danger">{t("grokMove.refused", { file: item.file, reason: item.error })}</p>)}
    </>
  );

  if (!linkAvailable) {
    return (
      <>
        <p className={LINE}>{t("grokMove.intro")}</p>
        {banner}
        <ManualPath roster={roster} reply={reply} error={error} onReply={onReply} onFile={onFile} />
      </>
    );
  }

  const addState: StepState = migratorHere ? "done" : "active";
  const linkState: StepState = url ? "done" : "active";
  const sendState: StepState = !url ? "waiting" : gotArrived ? "done" : "active";
  const arriveState: StepState = gotArrived ? "done" : url ? "active" : "waiting";

  return (
    <>
      <p className={LINE}>{t("grokMove.lead")}</p>
      {banner}
      <ol data-grok-move-steps data-grok-move-connect className="flex flex-col gap-5">
        <Step id="add" number={1} state={addState} title={t("grokMove.guide.addTitle")}>
          <p className={LINE}>{t("grokMove.guide.addHint")}</p>
          {migratorHere && <p data-grok-move-migrator-found className={LINE}>{t("grokMove.guide.addDone")}</p>}
          <button type="button" data-grok-move-template onClick={() => void openExternalLink(SEIRA_GROK_TEMPLATE_URL)} className={cn(SECONDARY, "inline-flex items-center gap-2")}>
            <ExternalLink size={15} />{t("grokMove.guide.addOpen")}
          </button>
        </Step>
        <Step id="link" number={2} state={linkState} title={t("grokMove.guide.linkTitle")}>
          {url ? (
            <>
              <div className="flex w-full items-center gap-2">
                <input readOnly value={url} aria-label={t("grokMove.connect.linkLabel")} onFocus={(event) => event.target.select()}
                  className="min-w-0 flex-1 rounded-xl border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12px] text-ink focus:outline-none" />
                <button type="button" data-grok-move-copy-link onClick={copyLink} className={cn(SECONDARY, "inline-flex shrink-0 items-center gap-2")}>
                  {linkCopied === "copied" ? <Check size={15} /> : <Copy size={15} />}
                  {linkCopied === "copied" ? t("grokMove.copied") : linkCopied === "failed" ? t("grokMove.copyFailed") : t("grokMove.connect.copy")}
                </button>
              </div>
              <p className={LINE}>{t("grokMove.guide.linkPrivate")}</p>
            </>
          ) : (
            <>
              {stopped && <p role="status" data-grok-move-stopped className={LINE}>{t("grokMove.connect.stopped")}</p>}
              <button type="button" data-grok-move-connect-start disabled={connecting} onClick={onConnect} className={cn(SECONDARY, "inline-flex items-center gap-2")}>
                {connecting && <Loader2 size={15} className="animate-spin motion-reduce:animate-none" />}{t("grokMove.connect.start")}
              </button>
            </>
          )}
          {connectFailed && <p role="alert" className="text-[13px] leading-relaxed text-danger">{t("grokMove.connect.failed")}</p>}
        </Step>
        <Step id="send" number={3} state={sendState} title={t("grokMove.guide.sendTitle")}>
          {url ? (
            <>
              <p className={LINE}>{t("grokMove.guide.sendHint")}</p>
              <CopyButton text={message} label={t("grokMove.guide.sendCopy")} attribute="data-grok-move-copy-message" />
              <p className="text-[13px] leading-relaxed text-ink-tertiary">{t("grokMove.guide.sendManual")}</p>
            </>
          ) : (
            <p className={LINE}>{t("grokMove.guide.sendLater")}</p>
          )}
        </Step>
        <Step id="arrive" number={4} state={arriveState} title={t("grokMove.guide.arriveTitle")}>
          <p role="status" aria-live="polite" data-grok-move-status className={cn(LINE, "inline-flex items-center gap-2")}>
            {gotArrived ? (arrived.length === 1 ? t("grokMove.guide.arrivedOne") : t("grokMove.guide.arrivedMany", { count: arrived.length }))
              : url ? <><Loader2 size={13} className="animate-spin motion-reduce:animate-none" />{t("grokMove.guide.waiting")}</>
              : t("grokMove.guide.arriveLater")}
          </p>
          <Roster names={roster} arrived={arrived} />
        </Step>
      </ol>
      <div className="flex flex-col items-start gap-3">
        <button type="button" data-grok-move-manual-toggle aria-expanded={manualOpen} aria-controls={panel} onClick={onManualToggle}
          className="inline-flex items-center gap-1.5 text-[13px] text-ink-secondary transition-colors hover:text-ink">
          {t("grokMove.manual.toggle")}
          <ChevronDown size={14} className={cn("transition-transform motion-reduce:transition-none", manualOpen && "rotate-180")} />
        </button>
        <div id={panel} hidden={!manualOpen} className="w-full">
          <ManualPath roster={[]} reply={reply} error={error} onReply={onReply} onFile={onFile} />
        </div>
      </div>
    </>
  );
}
