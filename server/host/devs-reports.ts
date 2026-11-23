// @devs: a person's message that tags it makes exactly one bug report draft for the Seira team. A bot that calls
// report_bug for a message a person wrote without the tag, when they ask it to report a problem, makes one too. The bot answering it is
// asked (a note on its turn, and report_bug) to add a summary; when none comes, because its engine has no tools, its
// turn failed, it never called report_bug or no bot answered, the server writes the draft with its own facts once
// nothing runs in the conversation any more. The person's message and that summary are the only words in it, never
// the conversation.
//
// After Seira's own error (shared/bug-offer.ts says which count) the server also writes a draft on its own, from fixed
// sentences and the error's facts (bug-offer-report.ts), at most once a day for the same error and person.
//
// A draft never leaves this machine until the person it is for reads it and selects "Send report". Only that person
// sees its line in the chat (`bugOffer`, their reaction key). A report that cannot go yet waits in devs-reports.json
// and goes again on its own.
//
// Closing the loop: each report sent is followed (`tracked`, in the same file). Its line shows its status
// ("Got it, we're looking", then "Fixed in 0.1.x"), and this server asks the Seira team about its open reports at each
// start and about hourly, at the address it sends them to (devs-report-send.ts `askReportStatus`): one way on the desktop
// and on a Cloud, so nothing ever has to reach this server, or wake a sleeping Cloud. Once it runs the fix's release, and
// the team's answer says it may (never a former customer's Cloud), the person gets one line in the chat they reported in,
// "Fixed in 0.1.x. Want to try again?", with one notification, and the bot's next turn there is told why. Never twice.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { arch, platform, release } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { bugIssueUrl, isSeiraTool, seiraOwnsError, type BugDraftView, type ErrorFacts } from "../../shared/bug-offer.ts";
import { tagsDevs, withoutDevsTags } from "../../shared/devs-mention.ts";
import { versionAtLeast, type BugOffer, type BugReportStatus } from "../../shared/devs-report-status.ts";
import { failedTurnCause } from "../../shared/failed-turn.ts";
import { splitTranscriptCitations } from "../../src/lib/citations.ts";
import { PASTED_TEXT_CLOSE, PASTED_TEXT_OPEN } from "../../src/lib/composer-attachments.ts";
import { writeFileAtomic } from "../atomic.ts";
import { buildOfferReport, publicDevsReport, type OfferReportInput } from "../bug-offer-report.ts";
import { startDueTimer } from "../due-timer.ts";
import type { ProviderSnapshot } from "../contracts.ts";
import { buildDevsReport, environmentSecrets, redactReportText, type BotSummary, type DevsReportPayload, type ReportedBot } from "../devs-report.ts";
import { bugReportIssueUrl, bugReportTitle } from "../devs-report-issue.ts";
import { BUG_REPORT_STATUS_MAX_IDS, type ReportStatusAnswer, type ReportStatusQuestion, type SendOutcome } from "../devs-report-send.ts";
import { DEVS_REPORT_PATH } from "../drivers/agents-devs-tools.ts";
import type { json as sendJson } from "../harness/http.ts";
import type { RecentLog } from "../recent-log.ts";
import { PASS } from "../routes/table.ts";
import { serverLine, type LineLanguage } from "../server-lines.ts";
import { cloudComputerCounters } from "../cloud-computer-counters.ts";
import type { BotRecord, Message, Store, StoreChange } from "../store.ts";
import { draftLine, droppedLine, fullLine, laterLine, readyLine, refusedLine } from "./devs-report-words.ts";
import { clip } from "./text-clip.ts";

export const DEVS_REPORTS_FILE = "devs-reports.json";
const TICK_MS = 2_000;
/** No turn began this long after the message: no bot will write a summary. */
export const NO_ANSWER_MS = 20_000;
/** A turn still running this long after the message: the report goes without waiting for its summary. */
export const LONGEST_WAIT_MS = 10 * 60_000;
export const RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
const KEPT_MS = 7 * 24 * 3_600_000;
export const MAX_OUTBOX = 20;
const MAX_WAITING = 50;
/** A line older than this is history arriving (a restore, a move), not a person writing now. */
const FRESH_MS = 10 * 60_000;
const REPEAT_MS = 30 * 60_000;
const ALREADY_PREPARED = "Already prepared: report_bug writes one draft per message. Do not call it again for it.";
const NO_DRAFT = "No draft: report_bug writes a bug report for a message a person wrote, and no person wrote the message you are answering.";
const SCANNED_LINES = 300;

/** The first question about open reports after a start (an update starts the server, and is when a fix arrives), then how often. */
export const STATUS_FIRST_MS = 60_000;
export const STATUS_EVERY_MS = 60 * 60_000;
/** A report is asked about this long at most, then left with the status it last had. */
export const TRACKED_MS = 90 * 24 * 3_600_000;
/** After its fix line went, a report is kept this long for the note on the bot's next turn there. */
const TOLD_KEPT_MS = 7 * 24 * 3_600_000;
export const MAX_TRACKED = 100;
/** A draft nobody sent is let go after this, and its line goes with it. */
export const OFFER_KEPT_MS = 7 * 24 * 3_600_000;
/** A draft that went is kept this long: its line, and "an open report about the same error". */
const SENT_KEPT_MS = 30 * 24 * 3_600_000;
export const MAX_DRAFTS = 100;
/** One person's drafts: more push out only their own oldest, never another person's. */
export const MAX_DRAFTS_EACH = 20;
/** The reaction key of the person who runs this app. Only their drafts carry the server's own log, which they can read anyway. */
const OWNER = "user";
/** The same error is offered to the same person at most once in this time. */
export const OFFER_EVERY_MS = 24 * 3_600_000;
const MAX_OFFERED = 200;

const id = z.string().min(1).max(200);
const waitingSchema = z.object({ messageId: id, threadId: id, at: z.number(), text: z.string().max(20_000), words: z.string().max(20_000),
  sender: z.object({ name: z.string().max(200), id: z.string().max(200).optional() }).optional() });
const draftId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const fingerprintSchema = z.object({ kind: z.string().max(200), step: z.string().max(200).optional(), frame: z.string().max(200).optional() });
const payloadSchema = z.object({ installId: z.string(), source: z.literal("bot"), description: z.string(), appVersion: z.string(), platform: z.string(),
  diagnostics: z.string(), contactEmail: z.string().optional(), contact: z.string().optional(), title: z.string().max(200).optional(), fingerprint: fingerprintSchema.optional() });
const queuedSchema = z.object({ messageId: id, threadId: id, payload: payloadSchema, firstAt: z.number(), attempts: z.number().int().min(0), nextAt: z.number(),
  /** Who wrote @devs, so a later try's line reads in their language. */
  person: z.string().max(200).optional(),
  /** The draft the person sent: a later try updates its line and tells nothing more. */
  draftId: draftId.optional() });
/** A report a bot wrote. `for`: the reaction key of the one person who may read and send it. `sender`: their person key, for
 * the fix line's language and notification. `payload`: the issue as it will be published, kept until the relay takes it. */
const draftSchema = z.object({ id: draftId, threadId: id, anchorId: id.optional(), for: z.string().min(1).max(200), sender: z.string().max(200).optional(),
  from: z.enum(["error", "devs"]), by: z.string().max(200).optional(), at: z.number(), hash: z.string().max(64).optional(), title: z.string().max(200),
  state: z.enum(["offer", "saved", "sent", "joined", "opened"]), issue: z.number().int().positive().optional(), payload: payloadSchema.optional(),
  activity: z.number().int().min(0).optional(), model: z.string().max(200).optional(), words: z.string().max(400).optional() });
const offeredSchema = z.object({ hash: z.string().max(64), for: z.string().max(200), at: z.number() });
/** A report sent, followed until its fix runs here: `person` the reporter's key, `words` theirs (redacted, short) for the bot's note. */
const trackedSchema = z.object({ reportId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), threadId: id, messageId: id, installId: z.string().max(64), at: z.number(),
  person: z.string().max(200).optional(), words: z.string().max(400).optional(), status: z.enum(["received", "fixed"]),
  fixedIn: z.string().max(40).nullable().optional(), running: z.boolean().optional(), told: z.number().optional(), noted: z.boolean().optional() });
const fileSchema = z.object({ version: z.literal(1), waiting: z.array(waitingSchema).max(MAX_WAITING), outbox: z.array(queuedSchema).max(MAX_OUTBOX),
  tracked: z.array(trackedSchema).max(MAX_TRACKED).optional(), drafts: z.array(draftSchema).max(MAX_DRAFTS).optional(), offered: z.array(offeredSchema).max(MAX_OFFERED).optional() });
const bodySchema = z.object({
  went_wrong: z.string().trim().min(1).max(2_000), you_saw: z.string().trim().max(3_000).optional(), steps: z.string().trim().max(2_000).optional(),
}).strict();

type Waiting = z.infer<typeof waitingSchema> & { answered?: boolean; offered?: boolean; restored?: boolean };
type Queued = z.infer<typeof queuedSchema>;
type Tracked = z.infer<typeof trackedSchema>;
type Draft = z.infer<typeof draftSchema>;
/** A line in the chat about a report that went later: what it says, and the issue form when nothing was sent. */
type Told = { ok: boolean; line: string; link?: string };
type Author = { bot: BotRecord; summary: BotSummary } | { why: string };
/** A failed row that may be Seira's own error, read once nothing runs in the conversation. */
type Pending = { threadId: string; rowId: string; at: number };
export type DraftRefusal = { error: "gone" } | { error: "busy" } | { error: "refused"; detail?: string };

export interface DevsReportsDeps {
  dataDir: string;
  store: Pick<Store, "bots" | "sections" | "bot" | "botByThread" | "groupByThread" | "projectBotForTask" | "activePath" | "appendMessage" | "patchMessage" | "onChange">;
  installId: string;
  appVersion: string;
  /** Where this server runs, as the team reads it: desktop app, My Cloud, Team Cloud… */
  runsOn: string;
  /** A turn runs, or is starting, in this conversation. */
  working(threadId: string): boolean;
  /** A routine or webhook run is writing in this conversation, so a line without a sendId is its, not a person's. */
  automated(threadId: string): boolean;
  engine(instanceId: string): { name: string; snapshot?: ProviderSnapshot } | null;
  appsReady(): boolean;
  language(): string | undefined;
  /** The language a line for this person is written in; absent, the one set on this server. */
  lineLanguage?: LineLanguage;
  recentLog: RecentLog;
  /** Timing lines for these conversations and bots: numbers, fixed codes and opaque ids only. */
  performance?(filter: { threadIds: readonly string[]; botIds: readonly string[] }): string[];
  send(payload: DevsReportPayload): Promise<SendOutcome>;
  /** Asks the Seira team about reports this app sent (devs-report-send.ts `askReportStatus`); null: no answer this time. */
  askStatus(question: ReportStatusQuestion): Promise<ReportStatusAnswer | null>;
  /** One notification about a line in this conversation; `person`, on a Team Cloud, the only one it reaches. */
  tell(threadId: string, text: string, person?: string): void;
  /** The reaction key of a line's sender: "user" where one person uses the workspace; null when no one person may see it. */
  reactorOf?(senderId: string | undefined): string | null;
  /** Names of this workspace's people: removed from a report wherever they appear. */
  personNames?(): string[];
  /** The relay takes a report in one click; false: the person opens a prefilled issue form and submits it there. */
  direct?: boolean;
  /** How often to ask about open reports (tests and fixtures; STATUS_EVERY_MS otherwise). */
  statusEveryMs?: number;
  now?: () => number;
  /** Tests: drive the clock by hand. */
  timer?: false;
}

export interface DevsReportContext {
  method: string;
  path: string;
  res: ServerResponse;
  json: typeof sendJson;
  botId: string;
  threadId: string;
  readBody: () => Promise<unknown>;
}

export { sentLine } from "./devs-report-words.ts";
/** The one line in the chat once this app runs the fix, in the reporter's language (clients say it from `bugReport`). */
export const fixedLine = (version: string, language?: string) => serverLine(language, "server.reports.fixed", { version });
/** Rides on the bot's next turn in that chat, once, so an answer to the line above makes sense to it. */
const fixedNote = (entry: Tracked, version: string) => `\n\n[From Seira, not the person: the problem they reported with @devs on ${new Date(entry.at).toISOString().slice(0, 10)}${
  entry.words ? ` ("${entry.words}")` : ""} is fixed in ${version}, which this app now runs. The chat told them so and asked whether they want to try again; if their message answers that, help them try it again.]`;

/** The person's own words: the text outside quotes and each quote's comment. Only a @devs there tags the message,
 * never one inside a message they quoted. */
function ownWords(message: string): string[] {
  const { display, citations } = splitTranscriptCitations(message);
  return [display, ...citations.map((citation) => citation.comment ?? "")];
}

/** The message without the blocks the composer wraps around text the person pasted in (composeMessage): like a
 * quote, a @devs inside a paste is theirs to read, not a tag they typed. One pass over the lines; a block ends at its
 * first closing line, as the transcript reads it, and an opening line with no closing line after it stays as text. */
function withoutPastes(message: string): string {
  const lines = message.split("\n");
  const kept: string[] = [];
  let open = -1;
  lines.forEach((line, index) => {
    const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (open < 0) {
      if (PASTED_TEXT_OPEN.test(bare)) open = index;
      else kept.push(line);
    } else if (PASTED_TEXT_CLOSE.test(bare)) open = -1;
  });
  return (open >= 0 ? kept.concat(lines.slice(open)) : kept).join("\n");
}

/** Rides on the turn that answers a @devs message. */
const TURN_NOTE = "\n\n[From Seira, not the person: this message tags @devs, so it is a bug report for the Seira team, Seira's developers. Call report_bug once, first: what the person says went wrong; what you saw yourself in this conversation (errors, failed tools, stuck steps), or that you saw nothing unusual; and steps to reproduce. Leave out passwords, keys, tokens and file contents; Seira adds the app's own diagnostics. report_bug writes a draft: nothing goes until the person reads it and sends it. Then tell the person, word for word, the line report_bug returns, and help with the problem if you can.]";

const iso = (at: number) => new Date(at).toISOString();
/** The report goes out even when the timings fail: their lines, or one saying they are missing. */
function performanceLines(read: NonNullable<DevsReportsDeps["performance"]>, threadId: string, botIds: string[]): string[] {
  try { return read({ threadIds: [threadId], botIds }); } catch { return ["## Performance", "(timings unavailable)"]; }
}
const firstLine = (text: string | undefined) => (text ?? "").split("\n").map((line) => line.trim()).find(Boolean) ?? "";

/** What went wrong in this conversation lately, as rows the server wrote: failed turns, failed tools, stops, notices. */
export function conversationProblems(lines: readonly Message[]): string[] {
  const found: string[] = [];
  for (const line of lines.slice(-SCANNED_LINES)) {
    const at = iso(line.at);
    if (line.kind === "activity" && line.tool) {
      const { name } = line.tool;
      const cause = failedTurnCause(name);
      if (cause !== null) found.push(`${at} turn failed: ${cause}${line.tool.setup ? " (needs setup)" : ""}`);
      else if (/^(stopped|notice|recovery):/.test(name)) found.push(`${at} ${name}`);
      else if (line.tool.ok === false) {
        const detail = clip(firstLine(line.tool.output), 200);
        found.push(`${at} tool ${name} failed${detail ? `: ${detail}` : ""}`);
      }
    } else if (line.role === "bot" && line.kind === "text" && line.turnSucceeded === false) {
      found.push(`${at} turn ${line.turnId ?? ""} ended without success`.replace("  ", " "));
    } else if (line.role === "user" && line.requestCancelled) {
      found.push(`${at} the person's request was stopped`);
    }
  }
  return found;
}

function health(snapshot: ProviderSnapshot | undefined): string {
  if (!snapshot) return "not checked yet";
  const signedIn = snapshot.authenticated === undefined ? "" : snapshot.authenticated ? ", signed in" : ", not signed in";
  return `${snapshot.state}${snapshot.reason ? ` (${clip(snapshot.reason, 200)})` : ""}${signedIn}${snapshot.version ? `, version ${snapshot.version}` : ""}`;
}

export function createDevsReports(deps: DevsReportsDeps) {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const file = join(deps.dataDir, DEVS_REPORTS_FILE);
  const reactorOf = deps.reactorOf ?? (() => "user");
  let waiting: Waiting[] = [];
  let outbox: Queued[] = [];
  let tracked: Tracked[] = [];
  let drafts: Draft[] = [];
  let offered: Array<z.infer<typeof offeredSchema>> = [];
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) {
      outbox = parsed.data.outbox;
      waiting = parsed.data.waiting.map((entry) => ({ ...entry, restored: true }));
      tracked = parsed.data.tracked ?? [];
      drafts = parsed.data.drafts ?? [];
      offered = parsed.data.offered ?? [];
    } else console.warn(`devs reports: ${file} is not a reports file; starting fresh`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`devs reports: ${file} is unreadable; starting fresh`);
  }
  const sending = new Map<string, Promise<BugDraftView | DraftRefusal>>();
  const retrying = new Set<Queued>();
  const lastSent = new Map<string, { at: number; messageId: string }>();
  const seen = new Set<string>();
  /** Failed rows already read for an offer, so a patch to the same row is not read again. */
  const considered = new Set<string>();
  let pending: Pending[] = [];

  const save = () => {
    try {
      writeFileAtomic(file, `${JSON.stringify({ version: 1, waiting: waiting.map(({ answered: _a, offered: _o, restored: _r, ...entry }) => entry), outbox, tracked, drafts, offered })}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`devs reports: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const notice = (threadId: string, said: Told) => {
    try { store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: `notice: ${said.line}`, ok: said.ok, ...(said.link ? { bugReportUrl: said.link } : {}) } }); }
    catch { /* the conversation is gone; the report still went */ }
  };
  // A bot or a department named devs is tagged instead.
  const namesBeforeDevs = () => [...store.bots.map((bot) => bot.name), ...store.sections];
  const secrets = () => environmentSecrets();
  const languageFor = (person: string | undefined) => (deps.lineLanguage ? deps.lineLanguage(person) : deps.language());

  /** The person's message shows its report's status; patched only when what it shows changes. */
  const view = (entry: Tracked): BugReportStatus => ({ id: entry.reportId, status: entry.status,
    ...(entry.status === "fixed" && entry.fixedIn ? { fixedIn: entry.fixedIn } : {}), ...(entry.running ? { running: true as const } : {}) });
  const show = (entry: Tracked) => {
    try { store.patchMessage(entry.threadId, entry.messageId, { bugReport: view(entry) }); } catch { /* the conversation is gone */ }
  };
  /** A report the team took: followed from now, and its line says "Got it". */
  function track(entry: { messageId: string; threadId: string }, reportId: string, payload: DevsReportPayload, person: string | undefined, words: string) {
    const kept: Tracked = { reportId, threadId: entry.threadId, messageId: entry.messageId, installId: payload.installId.slice(0, 64), at: now(),
      ...(person ? { person: person.slice(0, 200) } : {}), ...(words ? { words: clip(words.replace(/\s+/g, " ").trim(), 300) } : {}), status: "received" };
    tracked = [...tracked.filter((one) => one.reportId !== reportId), kept].slice(-MAX_TRACKED);
    show(kept);
  }
  const everyMs = Math.max(1_000, deps.statusEveryMs ?? STATUS_EVERY_MS);
  let nextAskAt = now() + Math.min(STATUS_FIRST_MS, everyMs);
  let asking: Promise<void> | null = null;
  /** Still asked about: its fix hasn't been told here, and it isn't older than TRACKED_MS. */
  const open = (entry: Tracked) => entry.told === undefined && now() - entry.at < TRACKED_MS;

  /** Once this app runs the fix and the team's answer allows it: one line in the chat, one notification, recorded first. */
  function tellFixed(entry: Tracked, version: string) {
    entry.told = now();
    save();
    const text = fixedLine(version, languageFor(entry.person));
    try {
      store.appendMessage(entry.threadId, { role: "bot", kind: "activity", tool: { name: `notice: ${text}`, ok: true },
        bugReport: { id: entry.reportId, status: "fixed", fixedIn: version, running: true } });
    } catch { return; /* the conversation is gone: nobody to tell */ }
    deps.tell(entry.threadId, text, entry.person);
  }

  /** What the team said about one report: its status shown, and its fix told once when this app runs it and may tell. */
  function learn(entry: Tracked, said: ReportStatusAnswer["reports"][number], notify: boolean) {
    if (said.status === "unknown") { tracked = tracked.filter((one) => one !== entry); return; }
    const fixedIn = said.status === "fixed" ? said.fixedIn : null;
    const running = fixedIn !== null && versionAtLeast(deps.appVersion, fixedIn);
    const changed = entry.status !== said.status || (entry.fixedIn ?? null) !== fixedIn || Boolean(entry.running) !== running;
    entry.status = said.status;
    entry.fixedIn = fixedIn;
    if (running) entry.running = true; else delete entry.running;
    if (changed) show(entry);
    if (running && fixedIn !== null && notify && entry.told === undefined) tellFixed(entry, fixedIn);
  }

  /** One round of questions about the open reports, by the install that sent them; no answer leaves everything for the next round. */
  async function ask(): Promise<void> {
    const byInstall = new Map<string, Tracked[]>();
    for (const entry of tracked) if (open(entry)) byInstall.set(entry.installId, [...(byInstall.get(entry.installId) ?? []), entry]);
    for (const [installId, entries] of byInstall) {
      for (let from = 0; from < entries.length; from += BUG_REPORT_STATUS_MAX_IDS) {
        const batch = entries.slice(from, from + BUG_REPORT_STATUS_MAX_IDS);
        const answer = await deps.askStatus({ installId, ids: batch.map((entry) => entry.reportId) }).catch(() => null);
        if (!answer) return;
        for (const said of answer.reports) {
          const entry = batch.find((one) => one.reportId === said.id);
          if (entry && tracked.includes(entry)) learn(entry, said, answer.notify);
        }
      }
    }
  }
  /** Reports told long ago, and those followed past TRACKED_MS, are let go; their messages keep what they last showed. */
  const prune = () => {
    tracked = tracked.filter((entry) => entry.told === undefined ? now() - entry.at < TRACKED_MS : now() - entry.told < TOLD_KEPT_MS);
  };

  function reported(bot: BotRecord, threadId: string): ReportedBot {
    const effective = store.projectBotForTask(bot.id, threadId) ?? bot;
    const { instanceId, model, effort, variant } = effective.modelSelection;
    const engine = deps.engine(instanceId);
    const grants = effective.connectorTools ? Object.keys(effective.connectorTools) : null;
    const apps = !deps.appsReady() ? "not set up" : effective.composio === false ? "off for this bot"
      : grants === null ? "on, every connected app" : grants.length ? `on: ${grants.slice(0, 12).join(", ")}` : "on, no app granted";
    return { id: bot.id, name: bot.name, engine: engine?.name ?? "unknown engine", instanceId, model, ...(effort ? { effort } : {}),
      ...(variant ? { variant } : {}), health: engine ? health(engine.snapshot) : "not installed", apps };
  }

  /** After the @devs message: the bots that spoke in a group chat, else the conversation's own bot. */
  function botsFor(entry: Waiting, author: Author): { bots: BotRecord[]; where: string; groupId?: string } {
    const group = store.groupByThread(entry.threadId);
    if (group) {
      const path = store.activePath(entry.threadId);
      const after = path.slice(path.findIndex((line) => line.id === entry.messageId) + 1);
      const spoke = new Set(after.flatMap((line) => (line.from?.botId ? [line.from.botId] : [])));
      const members = group.memberIds.map((member) => store.bot(member)).filter((bot): bot is BotRecord => Boolean(bot && !bot.hidden));
      const chosen = "bot" in author ? [author.bot] : members.filter((bot) => spoke.has(bot.id));
      return { bots: (chosen.length ? chosen : members).slice(0, 6), where: `the group chat "${group.name}" with ${members.length} bot${members.length === 1 ? "" : "s"}`, groupId: group.id };
    }
    const owner = "bot" in author ? author.bot : store.botByThread(entry.threadId);
    return { bots: owner ? [owner] : [], where: owner ? `a chat with ${owner.name}` : "a conversation" };
  }

  function build(entry: Waiting, author: Author): { payload: DevsReportPayload; bots: ReportedBot[]; problems: number; log: number } {
    const { bots, where, groupId } = botsFor(entry, author);
    const runsOn = deps.runsOn;
    const problems = conversationProblems(store.activePath(entry.threadId)), log = deps.recentLog();
    const shown = bots.map((bot) => reported(bot, entry.threadId));
    const payload = buildDevsReport({
      installId: deps.installId, appVersion: deps.appVersion, platform: `${platform()} ${arch()}, ${runsOn}`, os: `${platform()} ${release()} ${arch()}`,
      runsOn, node: process.version, uptimeSeconds: Math.round(process.uptime()), language: deps.language(), now: now(),
      threadId: entry.threadId, messageId: entry.messageId, ...(groupId ? { groupId } : {}), where, message: entry.text, words: entry.words,
      bots: shown,
      ...("bot" in author ? { summary: { by: author.bot.name, text: author.summary } } : { noSummary: author.why }),
      problems, log, cloudComputers: cloudComputerCounters.lines(),
      ...(deps.performance ? { performance: performanceLines(deps.performance, entry.threadId, bots.map((bot) => bot.id)) } : {}),
    }, secrets());
    return { payload, bots: shown, problems: problems.length, log: log.length };
  }

  const offerOf = (draft: Draft): BugOffer => ({ id: draft.id, for: draft.for, from: draft.from, ...(draft.by ? { by: draft.by } : {}), state: draft.state,
    ...(draft.issue ? { issue: draft.issue } : {}) });
  /** The draft's line under its anchor: written whenever its state changes, removed when the draft goes. */
  const showOffer = (draft: Draft) => {
    if (!draft.anchorId) return;
    try { store.patchMessage(draft.threadId, draft.anchorId, { bugOffer: offerOf(draft) }); } catch { /* the conversation is gone */ }
  };
  const hideOffer = (draft: Draft) => {
    if (!draft.anchorId) return;
    try { store.patchMessage(draft.threadId, draft.anchorId, { bugOffer: undefined }); } catch { /* the conversation is gone */ }
  };
  const newDraftId = () => randomBytes(12).toString("base64url");

  function keepDraft(draft: Draft): Draft {
    drafts.push(draft);
    const drop = (oldest: Draft) => {
      drafts = drafts.filter((one) => one !== oldest);
      if (oldest.state === "offer") hideOffer(oldest);
    };
    for (let own = drafts.filter((one) => one.for === draft.for); own.length > MAX_DRAFTS_EACH; own = own.slice(1)) {
      const oldest = own.find((one) => one.state !== "saved" && !sending.has(one.id)) ?? own[0]!;
      own = [oldest, ...own.filter((one) => one !== oldest)];
      drop(oldest);
    }
    while (drafts.length > MAX_DRAFTS) drop(drafts.find((one) => one.state !== "saved" && !sending.has(one.id)) ?? drafts[0]!);
    save();
    showOffer(draft);
    return draft;
  }

  /** What the person reads before they send: the issue as it will be published, and what it carries. */
  function draftView(draft: Draft): BugDraftView {
    const reported = draft.hash ? drafts.filter((one) => one !== draft && one.hash === draft.hash && (one.state === "sent" || one.state === "joined")) : [];
    const own = reported.find((one) => one.for === draft.for);
    const other = own ? undefined : reported.find((one) => one.issue);
    const same = own ? { title: own.title, at: own.at, ...(own.issue ? { issue: own.issue } : {}) } : other ? { issue: other.issue! } : undefined;
    const { payload } = draft;
    return {
      id: draft.id, from: draft.from, ...(draft.by ? { by: draft.by } : {}), state: draft.state, ...(draft.issue ? { issue: draft.issue } : {}),
      title: draft.title, description: payload?.description ?? "", diagnostics: payload?.diagnostics ?? "",
      included: { version: payload?.appVersion ?? deps.appVersion, platform: payload?.platform ?? "", ...(draft.model ? { model: draft.model } : {}), activity: draft.activity ?? 0 },
      direct: deps.direct ?? true,
      formUrl: payload ? bugReportIssueUrl(payload) : draft.issue ? bugIssueUrl(draft.issue) : "",
      ...(same ? { same } : {}),
    };
  }

  /** @devs: the draft for the person's message, written from the bot's summary or the server's own facts. Nothing is sent. */
  function prepare(entry: Waiting, author: Author): Draft | null {
    waiting = waiting.filter((one) => one.messageId !== entry.messageId);
    lastSent.set(entry.threadId, { at: now(), messageId: entry.messageId });
    // A message nobody can be named for gets no draft: nobody could read or send it.
    const person = reactorOf(entry.sender?.id);
    if (person === null) return null;
    const built = build(entry, author);
    const path = store.activePath(entry.threadId);
    const payload = publicDevsReport(built.payload, secrets(), { names: peopleNamed(path), whole: person === OWNER });
    const model = built.bots[0]?.model;
    return keepDraft({ id: newDraftId(), threadId: entry.threadId, anchorId: entry.messageId, for: person,
      ...(entry.sender?.id ? { sender: entry.sender.id } : {}), from: "devs", ...("bot" in author ? { by: author.bot.name } : {}), at: now(),
      title: bugReportTitle(payload), state: "offer", payload, activity: built.problems + built.log, ...(model ? { model: clip(model, 200) } : {}),
      ...(entry.words ? { words: clip(entry.words.replace(/\s+/g, " ").trim(), 300) } : {}) });
  }

  /** The bot-written report about one error in this conversation, with the facts the server has about it. */
  /** The people named in the conversation and in this workspace: no public issue holds their names. */
  const peopleNamed = (path: readonly Message[]) => [...path.flatMap((line) => (line.sender?.name ? [line.sender.name] : [])), ...(deps.personNames?.() ?? [])];

  function errorReport(threadId: string, path: readonly Message[], at: number, facts: ErrorFacts, where: OfferReportInput["where"], recovered: boolean, botId: string | undefined, person: string) {
    const start = path.slice(0, at).findLastIndex((line) => line.role === "user");
    const steps = path.slice(start + 1, at + 1).flatMap((line) => line.kind === "activity" && line.tool && failedTurnCause(line.tool.name) === null
      && !/^(stopped|notice|recovery):/.test(line.tool.name) ? [{ tool: line.tool.name, ok: line.tool.ok !== false }] : []);
    const bot = (botId ? store.bot(botId) : undefined) ?? store.botByThread(threadId);
    const shown = bot ? reported(bot, threadId) : undefined;
    const names = peopleNamed(path);
    const messages = path.flatMap((line) => (line.role === "user" && line.text ? [line.text] : []));
    return buildOfferReport({
      installId: deps.installId, appVersion: deps.appVersion, platform: `${platform()} ${arch()}, ${deps.runsOn}`, os: `${platform()} ${release()} ${arch()}`,
      runsOn: deps.runsOn, node: process.version, ...(deps.language() ? { language: deps.language() } : {}), error: facts, where, recovered, steps,
      ...(shown ? { engine: { name: shown.engine, model: shown.model, health: shown.health } } : {}),
      // The server's log holds other conversations too: only the person who runs the app reads it in a draft.
      problems: conversationProblems(path), log: person === OWNER ? deps.recentLog() : [], names, messages,
    }, secrets());
  }

  /** A failed row, read once nothing runs in its conversation: when the error is Seira's own, a draft for the person who asked. */
  function offerAfter(one: Pending): void {
    const path = store.activePath(one.threadId);
    const at = path.findIndex((line) => line.id === one.rowId);
    const row = path[at];
    if (!row?.tool) return;
    const cause = failedTurnCause(row.tool.name);
    const after = path.slice(at + 1);
    let facts: ErrorFacts, where: OfferReportInput["where"], anchor: Message;
    if (cause !== null) {
      const { setup, claudeUpdate, limitResetsAt, place, nameCode } = row.tool;
      facts = { text: cause, setup, claudeUpdate, limitResetsAt, place, nameCode };
      where = row.tool.partial ? "step" : "turn";
      anchor = row;
    } else {
      // The turn's failed row speaks for the whole turn.
      const end = after.findIndex((line) => line.role === "user");
      const turn = end < 0 ? after : after.slice(0, end);
      if (turn.some((line) => line.kind === "activity" && line.tool && failedTurnCause(line.tool.name) !== null)) return;
      facts = { text: row.tool.output ?? "", tool: row.tool.name };
      where = "step";
      anchor = turn.findLast((line) => line.role === "bot" && line.kind === "text") ?? row;
    }
    if (anchor.bugOffer || !seiraOwnsError(facts)) return;
    const asker = path.slice(0, at).findLast((line) => line.role === "user");
    const person = reactorOf(asker?.sender?.id);
    if (person === null) return;
    const report = errorReport(one.threadId, path, at, facts, where, cause !== null ? Boolean(row.tool.partial) : anchor !== row, row.from?.botId, person);
    offered = offered.filter((entry) => now() - entry.at < OFFER_EVERY_MS);
    if (offered.some((entry) => entry.hash === report.hash && entry.for === person)) return;
    offered = [...offered, { hash: report.hash, for: person, at: now() }].slice(-MAX_OFFERED);
    const bot = (row.from?.botId ? store.bot(row.from.botId) : undefined) ?? store.botByThread(one.threadId);
    keepDraft({ id: newDraftId(), threadId: one.threadId, anchorId: anchor.id, for: person, ...(asker?.sender?.id ? { sender: asker.sender.id } : {}),
      from: "error", ...(bot ? { by: bot.name } : {}), at: now(), hash: report.hash, title: report.title, state: "offer", payload: report.payload,
      activity: report.activity, ...(report.model ? { model: clip(report.model, 200) } : {}), words: report.title });
  }

  /** A failed row in a conversation: kept to read once its turn is over. */
  function failedRow(threadId: string, line: Message): void {
    const tool = line.tool;
    if (!tool || tool.ok !== false || considered.has(line.id) || now() - line.at > FRESH_MS) return;
    const turnFailed = failedTurnCause(tool.name) !== null;
    if (!turnFailed && !(isSeiraTool(tool.name) && (tool.output ?? "").trim())) return;
    considered.add(line.id);
    if (considered.size > 1_000) considered.delete(considered.values().next().value!);
    pending.push({ threadId, rowId: line.id, at: now() });
    timer?.poke();
  }

  /** The person's answer to a draft: it goes now, waits in the outbox, or (refused) stays a draft they may send again. */
  function settleDraft(draft: Draft, payload: DevsReportPayload, outcome: SendOutcome): DraftRefusal | null {
    if (outcome.ok) {
      if ("issueUrl" in outcome) draft.state = "opened";
      else {
        draft.state = outcome.joined ? "joined" : "sent";
        if (outcome.issue) draft.issue = outcome.issue;
        if (draft.anchorId) track({ messageId: draft.anchorId, threadId: draft.threadId }, outcome.id, payload, draft.sender, draft.words ?? draft.title);
        delete draft.payload;
      }
      return null;
    }
    if (!outcome.retry) return { error: "refused", detail: outcome.detail };
    if (outbox.length >= MAX_OUTBOX) return { error: "refused" };
    outbox.push({ messageId: draft.anchorId ?? draft.id, threadId: draft.threadId, payload, firstAt: now(), attempts: 1,
      nextAt: now() + (outcome.retryAfterMs ?? RETRY_MS[0]), ...(draft.sender ? { person: draft.sender } : {}), draftId: draft.id });
    draft.state = "saved";
    timer?.poke();
    return null;
  }

  /** "Send report": the one place a draft leaves this machine, and only for the person it is for. */
  function sendDraft(id: string, person: string): Promise<BugDraftView | DraftRefusal> {
    const draft = drafts.find((one) => one.id === id && one.for === person);
    if (!draft) return Promise.resolve({ error: "gone" });
    const running = sending.get(id);
    if (running) return running;
    const payload = draft.payload;
    if (draft.state !== "offer" || !payload) return Promise.resolve(draftView(draft));
    const attempt = (async (): Promise<BugDraftView | DraftRefusal> => {
      const outcome = await deps.send(payload).catch((): SendOutcome => ({ ok: false, retry: true, why: "offline" }));
      if (!drafts.includes(draft)) return { error: "gone" };
      const refused = settleDraft(draft, payload, outcome);
      if (refused) return refused;
      save();
      showOffer(draft);
      return draftView(draft);
    })().finally(() => sending.delete(id));
    sending.set(id, attempt);
    return attempt;
  }

  /** Why no bot wrote the summary, read once the conversation is quiet. */
  function why(entry: Waiting): string {
    if (entry.restored) return "Seira restarted before a bot wrote one";
    if (!entry.answered) return "no bot answered the message";
    if (entry.offered === false) return "the bot's engine cannot use Seira's tools";
    const path = store.activePath(entry.threadId);
    const after = path.slice(path.findIndex((line) => line.id === entry.messageId) + 1);
    if (after.some((line) => line.kind === "activity" && line.tool && failedTurnCause(line.tool.name) !== null)) return "the bot's turn failed";
    return "the bot did not call report_bug";
  }

  async function retry(queued: Queued): Promise<void> {
    retrying.add(queued);
    const outcome = await deps.send(queued.payload).catch((): SendOutcome => ({ ok: false, retry: true, why: "offline" })).finally(() => retrying.delete(queued));
    if (queued.draftId !== undefined) {
      // A draft the person sent: its line follows what happens, and no other line is added.
      const draft = drafts.find((one) => one.id === queued.draftId);
      const gone = !outcome.ok && (!outcome.retry || now() - queued.firstAt > KEPT_MS);
      if (outcome.ok || gone) {
        outbox = outbox.filter((one) => one !== queued);
        if (draft && outcome.ok) settleDraft(draft, queued.payload, outcome);
        else if (draft) { draft.state = "offer"; draft.payload = queued.payload; }
        if (draft) showOffer(draft);
      } else {
        queued.attempts += 1;
        queued.nextAt = now() + (outcome.retryAfterMs ?? RETRY_MS[Math.min(queued.attempts - 1, RETRY_MS.length - 1)]!);
      }
      save();
      return;
    }
    const contact = queued.payload.contactEmail ?? queued.payload.contact, language = languageFor(queued.person);
    if (outcome.ok) {
      outbox = outbox.filter((one) => one !== queued);
      if ("issueUrl" in outcome) {
        notice(queued.threadId, { ok: true, line: readyLine(language), link: outcome.issueUrl });
      } else {
        track(queued, outcome.id, queued.payload, queued.person, queued.payload.description.split("\n")[0] ?? "");
        notice(queued.threadId, { ok: true, line: laterLine(outcome.id, outcome.noReply ? undefined : contact, language) });
      }
    } else if (!outcome.retry) {
      outbox = outbox.filter((one) => one !== queued);
      notice(queued.threadId, { ok: false, line: refusedLine(outcome.detail, language) });
    } else if (now() - queued.firstAt > KEPT_MS) {
      outbox = outbox.filter((one) => one !== queued);
      notice(queued.threadId, { ok: false, line: droppedLine(language) });
    } else {
      queued.attempts += 1;
      queued.nextAt = now() + (outcome.retryAfterMs ?? RETRY_MS[Math.min(queued.attempts - 1, RETRY_MS.length - 1)]!);
    }
    save();
  }

  /** Drafts nobody sent in OFFER_KEPT_MS, and those that went SENT_KEPT_MS ago, are let go. */
  function expire(): void {
    const old = drafts.filter((draft) => !sending.has(draft.id) && draft.state !== "saved"
      && now() - draft.at > (draft.state === "offer" ? OFFER_KEPT_MS : SENT_KEPT_MS));
    if (!old.length) return;
    drafts = drafts.filter((draft) => !old.includes(draft));
    for (const draft of old) if (draft.state === "offer") hideOffer(draft);
    save();
  }

  function tick(): void {
    for (const entry of waiting) {
      if (deps.working(entry.threadId)) {
        entry.answered = true;
        if (now() - entry.at >= LONGEST_WAIT_MS) prepare(entry, { why: "its turn was still running after 10 minutes" });
        continue;
      }
      if (!entry.answered && !entry.restored && now() - entry.at < NO_ANSWER_MS) continue;
      prepare(entry, { why: why(entry) });
    }
    for (const one of pending) {
      if (deps.working(one.threadId) && now() - one.at < LONGEST_WAIT_MS) continue;
      pending = pending.filter((other) => other !== one);
      try { offerAfter(one); } catch (error) {
        console.warn(`devs reports: could not write a bug report draft: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const queued of outbox) if (now() >= queued.nextAt && !retrying.has(queued)) void retry(queued);
    if (!asking && now() >= nextAskAt) {
      nextAskAt = now() + everyMs;
      prune();
      expire();
      if (tracked.some(open)) asking = ask().catch(() => {}).finally(() => { asking = null; prune(); save(); });
    }
  }

  /** The person's line that a turn in this conversation answers, when a person wrote it and no routine or teammate bot did. */
  function askedLine(threadId: string): Message | null {
    let path: readonly Message[];
    try { path = store.activePath(threadId); } catch { return null; }
    const line = path.findLast((one) => one.role === "user" && one.kind === "text");
    if (!line?.text || line.peerAsk || line.aside || line.automated) return null;
    if (!line.sendId && deps.automated(threadId)) return null;
    return line;
  }

  const prepared = (threadId: string, line: Message) => {
    const last = lastSent.get(threadId);
    return line.bugOffer !== undefined || drafts.some((one) => one.anchorId === line.id && one.from === "devs")
      || (last !== undefined && last.messageId === line.id && now() - last.at < REPEAT_MS);
  };

  /** report_bug from the bot answering a @devs message, or a message in which a person asks for a report: the draft, never a send. */
  function fromBot(botId: string, threadId: string, summary: BotSummary): { status: number; text: string } {
    const bot = store.bot(botId);
    if (!bot) return { status: 409, text: NO_DRAFT };
    const waited = waiting.filter((one) => one.threadId === threadId).at(-1);
    const asked = waited ? null : askedLine(threadId);
    const entry = waited ?? (asked && !prepared(threadId, asked) ? waitingFrom(threadId, asked) : undefined);
    if (!entry) {
      const last = lastSent.get(threadId);
      if (asked || (last && now() - last.at < REPEAT_MS)) return { status: 200, text: ALREADY_PREPARED };
      return { status: 409, text: NO_DRAFT };
    }
    if (!prepare(entry, { bot, summary })) return { status: 200, text: "No draft: nobody in this conversation can read and send it. Do not call report_bug again for it." };
    return { status: 200, text: `Ready for the person to review. Tell them this line in your reply, word for word: "${draftLine(languageFor(entry.sender?.id))}"` };
  }

  /** What a person's line becomes while it waits for a draft: its text and words, redacted. */
  function waitingFrom(threadId: string, line: Message, names: string[] = namesBeforeDevs()): Waiting {
    const redact = (text: string) => clip(redactReportText(text, secrets()), 3_000);
    return { messageId: line.id, threadId, at: line.at, text: redact(line.text ?? ""),
      words: redact(ownWords(line.text ?? "").map((part) => withoutDevsTags(part, names)).filter(Boolean).join("\n\n")),
      ...(line.sender ? { sender: { name: line.sender.name, ...(line.sender.id ? { id: line.sender.id } : {}) } } : {}) };
  }

  function personWrote(threadId: string, line: Message): void {
    if (seen.has(line.id) || !line.text || now() - line.at > FRESH_MS) return;
    if (!line.sendId && deps.automated(threadId)) return;
    const typed = ownWords(withoutPastes(line.text));
    if (!typed.some((part) => tagsDevs(part))) return;
    const names = namesBeforeDevs();
    if (!typed.some((part) => tagsDevs(part, names))) return;
    seen.add(line.id);
    if (seen.size > 1_000) seen.delete(seen.values().next().value!);
    if (waiting.length >= MAX_WAITING) return notice(threadId, { ok: false, line: fullLine(MAX_OUTBOX, languageFor(line.sender?.id)) });
    waiting.push(waitingFrom(threadId, line, names));
    save();
    timer?.poke();
  }

  const unsubscribe = store.onChange((change: StoreChange) => {
    if (change.type === "message" || change.type === "message.patch") {
      const line = change.message;
      if (change.type === "message" && line.role === "user" && line.kind === "text" && !line.peerAsk && !line.aside) personWrote(change.threadId, line);
      if (line.kind === "activity") failedRow(change.threadId, line);
    } else if (change.type === "thread.deleted") {
      const before = waiting.length + tracked.length + drafts.length + pending.length;
      waiting = waiting.filter((entry) => entry.threadId !== change.threadId);
      tracked = tracked.filter((entry) => entry.threadId !== change.threadId);
      drafts = drafts.filter((entry) => entry.threadId !== change.threadId);
      pending = pending.filter((entry) => entry.threadId !== change.threadId);
      if (waiting.length + tracked.length + drafts.length + pending.length !== before) save();
    }
  });
  // A waiting @devs line or failed row polls whether its turn is still running; otherwise nothing is due before a retry or a status ask.
  const timer = deps.timer === false ? null : startDueTimer({ run: tick, now, retryMs: TICK_MS,
    next: () => waiting.length || pending.length ? now() : Math.min(nextAskAt, ...outbox.map((queued) => queued.nextAt)) });

  return {
    /** The note on a turn in this conversation while a @devs message waits for its summary (none for a turn without
     * Seira's tools); and, on the first turn after its line, that a report's fix runs here now. Empty otherwise. */
    note(threadId: string, tools: boolean): string {
      const fixed = tracked.filter((one) => one.threadId === threadId && one.told !== undefined && !one.noted);
      for (const one of fixed) one.noted = true;
      if (fixed.length) save();
      const notes = fixed.map((one) => fixedNote(one, one.fixedIn ?? "")).join("");
      const entry = waiting.filter((one) => one.threadId === threadId).at(-1);
      if (!entry) return notes;
      entry.answered = true;
      entry.offered = entry.offered === true || tools;
      return notes + (tools ? TURN_NOTE : "");
    },
    /** A Team Cloud's member left: their reports are no longer followed, and their drafts nobody sent are let go. */
    forget(person: string) {
      const before = tracked.length + drafts.length;
      tracked = tracked.filter((entry) => entry.person !== person);
      const theirs = drafts.filter((draft) => draft.state === "offer" && (draft.sender === person || draft.for === person));
      drafts = drafts.filter((draft) => !theirs.includes(draft));
      for (const draft of theirs) hideOffer(draft);
      if (tracked.length + drafts.length !== before) save();
    },
    /** The conversation a draft belongs to, so a route checks the reader may see it before anything else. */
    draftThread(id: string): string | null {
      return drafts.find((draft) => draft.id === id)?.threadId ?? null;
    },
    viewDraft(id: string, person: string): BugDraftView | null {
      const draft = drafts.find((one) => one.id === id && one.for === person);
      return draft ? draftView(draft) : null;
    },
    sendDraft,
    /** "Not now": the draft and its line go, and nothing is kept to send later. */
    dismissDraft(id: string, person: string): "ok" | "gone" | "busy" {
      const draft = drafts.find((one) => one.id === id && one.for === person);
      if (!draft) return "gone";
      if (draft.state !== "offer" || sending.has(id)) return "busy";
      drafts = drafts.filter((one) => one !== draft);
      hideOffer(draft);
      save();
      return "ok";
    },
    /** A request in the app failed (the chat's error banner): a draft without a line, when the error is Seira's own. */
    fromError(threadId: string, text: string, person: string): BugDraftView | null {
      const facts: ErrorFacts = { text: clip(text, 4_000) };
      if (!seiraOwnsError(facts)) return null;
      let path: readonly Message[] = [];
      try { path = store.activePath(threadId); } catch { /* no conversation: the report has no steps */ }
      const report = errorReport(threadId, path, path.length, facts, "request", false, undefined, person);
      const earlier = drafts.find((draft) => draft.from === "error" && draft.for === person && draft.hash === report.hash && draft.state === "offer" && now() - draft.at < OFFER_EVERY_MS);
      if (earlier) return draftView(earlier);
      const bot = store.botByThread(threadId);
      return draftView(keepDraft({ id: newDraftId(), threadId, for: person, from: "error", ...(bot ? { by: bot.name } : {}), at: now(), hash: report.hash,
        title: report.title, state: "offer", payload: report.payload, activity: report.activity, ...(report.model ? { model: clip(report.model, 200) } : {}), words: report.title }));
    },
    /** The internal call behind report_bug, inside index.ts's /api/internal/ block: the bot and the conversation are the
     * capability's, never a body field. */
    async internal(ctx: DevsReportContext): Promise<typeof PASS | void> {
      if (ctx.path !== DEVS_REPORT_PATH) return PASS;
      if (ctx.method !== "POST") return ctx.json(ctx.res, 405, { error: "method not allowed" });
      const body = bodySchema.safeParse(await ctx.readBody());
      if (!body.success) return ctx.json(ctx.res, 400, { error: "report_bug needs went_wrong (up to 2,000 characters), and may add you_saw and steps." });
      const { went_wrong: wentWrong, you_saw: seenByBot, steps } = body.data;
      const answer = fromBot(ctx.botId, ctx.threadId, { wentWrong, ...(seenByBot ? { seen: seenByBot } : {}), ...(steps ? { steps } : {}) });
      return ctx.json(ctx.res, answer.status, answer.status === 200 ? { text: answer.text } : { error: answer.text });
    },
    tick,
    /** Tests: settles every send and question in flight. */
    idle: async () => {
      while (sending.size || retrying.size || asking) await Promise.allSettled([...sending.values(), asking]).then(() => new Promise((resolve) => setImmediate(resolve)));
    },
    stop() { unsubscribe(); timer?.stop(); },
  };
}

export type DevsReports = ReturnType<typeof createDevsReports>;
