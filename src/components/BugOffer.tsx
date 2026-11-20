import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Bug, ChevronRight, CircleCheck, Clock, ExternalLink, Loader2, WifiOff, X } from "lucide-react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { useAdvancedMode } from "@/lib/interface-mode";
import { useReactor } from "@/lib/cloud-guest";
import { createBugDraft, dismissBugDraft, fetchBugDraft, sendBugDraft, setBugDraftOpen, useBugDraftOpen } from "@/lib/bug-offer";
import type { Message } from "@/state/store";
import { bugIssueUrl, type BugDraftView } from "../../shared/bug-offer";
import type { BugOffer } from "../../shared/devs-report-status";
import { bugReportStatusText } from "./BugReportNote";

const LINK = "underline underline-offset-2 hover:text-ink";

/** What became of an offer the person answered, in their words. Null while it waits. */
export function bugOfferStatusText(offer: Pick<BugOffer, "state" | "issue">): string | null {
  switch (offer.state) {
    case "sent": return offer.issue ? t("bugOffer.status.sent", { issue: offer.issue }) : t("devs.report.received");
    case "joined": return offer.issue ? t("bugOffer.status.joined", { issue: offer.issue }) : t("bugOffer.status.joinedNoIssue");
    case "saved": return t("bugOffer.status.saved");
    case "opened": return t("bugOffer.status.opened");
    default: return null;
  }
}

/** The text with its "#N" turned into a link to that public issue. */
function withIssueLink(text: string, issue: number | undefined): ReactNode {
  if (!issue) return text;
  const mark = `#${issue}`;
  const at = text.indexOf(mark);
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <a href={bugIssueUrl(issue)} target="_blank" rel="noreferrer" className={LINK}>{mark}</a>
      {text.slice(at + mark.length)}
    </>
  );
}

function offerText(offer: BugOffer): string {
  if (offer.from === "devs") return offer.by ? t("bugOffer.line.devs", { name: offer.by }) : t("bugOffer.line.devsNoName");
  return offer.by ? t("bugOffer.line.error", { name: offer.by }) : t("bugOffer.line.errorNoName");
}

const LINE = "flex min-h-6 min-w-0 flex-wrap items-center gap-x-1 text-[12px] leading-6 text-ink-tertiary";

/** Under a line of the chat: a bug report a bot wrote, or what became of it. Only the person it is for sees it. */
export function BugOfferLine({ message, hideOfferLine = false }: { message: Pick<Message, "bugOffer" | "bugReport">; hideOfferLine?: boolean }) {
  const viewer = useReactor();
  const offer = message.bugOffer;
  const open = useBugDraftOpen(offer?.id ?? "");
  if (!offer || offer.for !== viewer) return null;
  const waiting = offer.state === "offer";
  const panel = open && (
    <BugDraftPanel id={offer.id} onClose={() => setBugDraftOpen(offer.id, false)} />
  );
  if (waiting && hideOfferLine) return panel || null;
  const fixed = message.bugReport?.status === "fixed" ? message.bugReport : undefined;
  const status = fixed ? bugReportStatusText(fixed) : bugOfferStatusText(offer);
  const Icon = fixed || waiting ? Bug : offer.state === "saved" ? Clock : CircleCheck;
  return (
    <div className="min-w-0">
      <div data-bug-offer={offer.state} role={waiting ? undefined : "status"} className={LINE}>
        <Icon aria-hidden="true" size={12} className={cn("me-1 shrink-0", !waiting && offer.state !== "saved" && "text-success")} />
        {waiting ? (
          <>
            <bdi dir="auto" className="min-w-0">{offerText(offer)}</bdi>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setBugDraftOpen(offer.id, !open)}
              className="rounded-full px-2 text-[12px] font-medium text-ink-secondary hover:bg-ink/10 hover:text-ink aria-expanded:bg-ink/10 aria-expanded:text-ink"
            >
              {t("bugOffer.review")}
            </button>
          </>
        ) : (
          <bdi dir="auto" className="min-w-0">{fixed ? status : withIssueLink(status ?? "", offer.issue)}</bdi>
        )}
      </div>
      {panel}
    </div>
  );
}

const REVIEW_TONE = {
  danger: "text-danger hover:bg-danger/15",
  warning: "text-warning hover:bg-warning/15",
} as const;

/** The failed-turn row's own "Review report" button: it opens the draft under the row. */
export function ReviewReportButton({ offerId, tone }: { offerId: string; tone: keyof typeof REVIEW_TONE }) {
  const open = useBugDraftOpen(offerId);
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => setBugDraftOpen(offerId, !open)}
      className={cn("ui-button ui-button-md mt-1.5 rounded-full border-transparent bg-transparent", REVIEW_TONE[tone])}
    >
      <Bug aria-hidden="true" size={12} /> {t("bugOffer.review")}
    </button>
  );
}

type Failure = "refused" | "loadFailed";

/** The draft as the person reads it. Pure: the panel around it loads, sends and closes. */
export function BugDraftBody({ view, advanced, sending = false, failure = null, saved = false, onSend, onNotNow, onClose, primaryRef }: {
  view: BugDraftView;
  advanced: boolean;
  sending?: boolean;
  failure?: Failure | null;
  saved?: boolean;
  onSend?: () => void;
  onNotNow?: () => void;
  onClose?: () => void;
  primaryRef?: (element: HTMLElement | null) => void;
}) {
  if (saved) {
    return (
      <>
        <p className="flex items-center gap-2 text-ink-secondary"><WifiOff aria-hidden="true" size={14} className="shrink-0 text-warning" />{t("bugOffer.saved.lead")}</p>
        <div className="flex justify-end"><button type="button" ref={primaryRef} onClick={onClose} className="ui-button ui-button-md rounded-full">{t("bugOffer.close")}</button></div>
      </>
    );
  }
  const same = view.same;
  const wrote = view.from === "devs";
  const rows: { label: string; value?: string }[] = [
    { label: t("bugOffer.row.happened") },
    { label: wrote ? t("bugOffer.row.wrote") : t("bugOffer.row.wrong") },
    { label: t("bugOffer.row.seira"), value: `${view.included.version} · ${view.included.platform}` },
    ...(view.included.model ? [{ label: t("bugOffer.row.ai"), value: view.included.model }] : []),
    { label: t("bugOffer.row.activity"), value: t("bugOffer.row.activityCount", { count: view.included.activity }) },
  ];
  const primaryLabel = sending ? t("bugOffer.sending") : same ? t("bugOffer.add") : t("bugOffer.send");
  const primaryClass = "ui-button ui-button-md ui-button-primary rounded-full";
  return (
    <>
      <p className="text-ink-secondary">
        {same
          ? view.by ? t("bugOffer.same.add", { name: view.by }) : t("bugOffer.same.addNoName")
          : view.by ? t("bugOffer.lead", { name: view.by }) : t("bugOffer.leadNoName")}
      </p>
      {same && (
        <div className="rounded-lg border border-hairline p-2.5">
          <p className="text-[12px] font-medium text-ink-secondary">{t("bugOffer.same.title")}</p>
          <p dir="auto" className="mt-0.5 break-words font-medium">
            {same.issue ? <a href={bugIssueUrl(same.issue)} target="_blank" rel="noreferrer" className={LINK}>#{same.issue}</a> : null}
            {same.issue && same.title ? " " : null}{same.title}
          </p>
          <p className="text-[12px] text-ink-tertiary">{t("bugOffer.same.looking")}</p>
        </div>
      )}
      <div dir="auto" className="grid gap-1 rounded-lg border border-hairline p-2.5">
        <p className="break-words font-semibold">{view.title}</p>
        <p className="whitespace-pre-wrap break-words text-ink-secondary">{view.description}</p>
      </div>
      <details className="group rounded-lg border border-hairline">
        <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-lg px-2.5 text-ink-secondary hover:bg-ink/5 [&::-webkit-details-marker]:hidden">
          <ChevronRight aria-hidden="true" size={14} className="shrink-0 transition-transform group-open:rotate-90 rtl:-scale-x-100" />
          <span>{t("bugOffer.included")}</span>
          <span className="ms-auto text-[12px] tabular-nums text-ink-tertiary">{rows.length}</span>
        </summary>
        <div className="grid gap-2 px-3 pb-3 pt-0.5">
          <ul className="grid gap-1.5">
            {rows.map((row) => (
              <li key={row.label} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
                <span className="text-[12px] text-ink-tertiary">{row.label}</span>
                <span className="break-words">{row.value}</span>
              </li>
            ))}
          </ul>
          <p className="text-[12px] text-ink-tertiary">{wrote ? t("bugOffer.neverDevs") : t("bugOffer.never")}</p>
        </div>
      </details>
      {advanced && (
        <details className="group rounded-lg border border-hairline">
          <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-lg px-2.5 text-ink-secondary hover:bg-ink/5 [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden="true" size={14} className="shrink-0 transition-transform group-open:rotate-90 rtl:-scale-x-100" />
            <span>{t("bugOffer.issueText")}</span>
          </summary>
          <div className="px-3 pb-3 pt-0.5">
            <pre dir="auto" className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-hairline p-2.5 font-mono text-[11px] leading-4">{`${view.title}\n\n${view.description}\n\n${view.diagnostics}`}</pre>
          </div>
        </details>
      )}
      {failure && <p role="alert" className="text-danger">{failure === "refused" ? t("bugOffer.refused") : t("bugOffer.loadFailed")}</p>}
      <div className="flex flex-wrap items-center gap-1.5">
        {view.direct && (
          <a href={view.formUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 whitespace-nowrap text-[12px] text-ink-secondary hover:text-ink">
            {t("bugOffer.writeOnGithub")}<ExternalLink aria-hidden="true" size={12} />
          </a>
        )}
        <span className="flex-1" />
        <button type="button" onClick={onNotNow} disabled={sending} className="ui-button ui-button-md rounded-full border-transparent bg-transparent text-ink-secondary hover:bg-ink/10 hover:text-ink disabled:opacity-50">
          {t("bugOffer.notNow")}
        </button>
        {view.direct ? (
          <button type="button" ref={primaryRef} onClick={onSend} disabled={sending} className={cn(primaryClass, "disabled:opacity-50")}>
            {sending && <Loader2 aria-hidden="true" size={14} className="animate-spin" />}{primaryLabel}
          </button>
        ) : (
          <a href={view.formUrl} target="_blank" rel="noreferrer" ref={primaryRef} onClick={onSend} className={primaryClass}>
            {t("devs.report.openOnGithub")}<ExternalLink aria-hidden="true" size={12} />
          </a>
        )}
      </div>
    </>
  );
}

/** The draft, open in place under the line or banner it belongs to. It is not a dialog: nothing blocks the chat behind it. */
export function BugDraftPanel({ id, create, initialView, onClose, onSettled }: {
  id?: string;
  create?: { threadId: string; error: string };
  initialView?: BugDraftView;
  onClose: () => void;
  onSettled?: (view: BugDraftView) => void;
}) {
  const advanced = useAdvancedMode();
  const [view, setView] = useState<BugDraftView | null>(initialView ?? null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [sending, setSending] = useState(false);
  const [saved, setSaved] = useState(false);
  const primary = useRef<HTMLElement | null>(null);
  const threadId = create?.threadId, error = create?.error;

  useEffect(() => {
    if (initialView) return undefined;
    let alive = true;
    const load = id ? fetchBugDraft(id) : threadId !== undefined && error !== undefined ? createBugDraft({ threadId, error }) : null;
    if (!load) { setFailure("loadFailed"); return undefined; }
    setFailure(null);
    load.then((next) => { if (alive) setView(next); }, () => { if (alive) setFailure("loadFailed"); });
    return () => { alive = false; };
  }, [id, threadId, error, initialView]);

  const loaded = view?.id;
  useEffect(() => { if (loaded) primary.current?.focus(); }, [loaded]);

  const send = async () => {
    if (!view || sending) return;
    setSending(true);
    setFailure(null);
    try {
      const next = await sendBugDraft(view.id);
      onSettled?.(next);
      if (next.state === "saved") { setSaved(true); setSending(false); return; }
      onClose();
    } catch {
      setFailure("refused");
      setSending(false);
    }
  };
  const notNow = () => {
    if (view) void dismissBugDraft(view.id).catch(() => undefined);
    onClose();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };
  const head = view?.by ? t("bugOffer.head", { name: view.by }) : t("bugOffer.headNoName");
  return (
    <div role="region" aria-label={head} onKeyDown={onKeyDown} className="mt-1.5 grid w-[min(26.25rem,100%)] gap-3 rounded-xl bg-menu p-4 text-[13px] leading-5 text-ink shadow-(--shadow-float)">
      <div className="-my-1 -me-1.5 flex items-center gap-2">
        <h3 className="min-w-0 flex-1 text-[14px] font-semibold leading-[18px]">{head}</h3>
        <button type="button" onClick={onClose} aria-label={t("bugOffer.close")} title={t("bugOffer.close")} className="ui-icon-button size-7 min-h-0 rounded-full p-0 hover:bg-ink/10"><X size={14} /></button>
      </div>
      {view ? (
        <BugDraftBody view={view} advanced={advanced} sending={sending} failure={failure} saved={saved} onSend={() => void send()} onNotNow={notNow} onClose={onClose} primaryRef={(element) => { primary.current = element; }} />
      ) : failure ? (
        <p role="alert" className="text-danger">{t("bugOffer.loadFailed")}</p>
      ) : (
        <Loader2 aria-hidden="true" size={14} className="animate-spin text-ink-tertiary" />
      )}
    </div>
  );
}

