// The bug report a bot writes after Seira's own error (shared/bug-offer.ts says which errors count). Once the person
// sends it, it is a public issue, so it holds no person's name, no file name, no path and none of their words: the bot
// writes it from fixed sentences and the error's facts, and every line passes the @devs redaction and cleanReportText.
import { createHash } from "node:crypto";

import { errorFingerprint, isSeiraTool, stepName, type ErrorFacts, type ErrorFingerprint } from "../shared/bug-offer.ts";
import { conversationDiagnostics } from "./devs-report-issue.ts";
import { GENERIC_REPORT_TITLE, cleanTitle, redactReportText, type DevsReportPayload } from "./devs-report.ts";
import { clip, oneLine } from "./host/text-clip.ts";

export interface OfferReportInput {
  installId: string;
  appVersion: string;
  platform: string;
  /** The operating system's name, release and architecture. */
  os: string;
  runsOn: string;
  node: string;
  language?: string;
  error: ErrorFacts;
  /** `step`: a step failed and the turn went on. `turn`: the turn stopped. `request`: a request the app made failed. */
  where: "step" | "turn" | "request";
  /** The turn went on and finished after the step failed. */
  recovered?: boolean;
  /** The turn's steps in order. */
  steps: ReadonlyArray<{ tool: string; ok: boolean }>;
  engine?: { name: string; model: string; health?: string };
  problems: readonly string[];
  log: readonly string[];
  /** Names of the people in the conversation and of this workspace's people: removed wherever they appear. */
  names: readonly string[];
  /** The person's own messages in the conversation: none of their text may appear. */
  messages: readonly string[];
}

export interface OfferReport {
  payload: DevsReportPayload;
  title: string;
  fingerprint: ErrorFingerprint;
  /** The fingerprint's hash: this app's key for "the same error". */
  hash: string;
  /** How many lines of recent activity the report carries. */
  activity: number;
  model?: string;
}

const LIMITS = { title: 120, field: 40, errorLines: 40, steps: 20, problems: 20, log: 40, line: 300 } as const;
const FILE_TYPES = "xlsx|xlsm|xls|csv|tsv|docx?|odt|ods|odp|rtf|pdf|pptx?|key|numbers|pages|txt|md|json|ya?ml|xml|html?|png|jpe?g|gif|webp|heic|svg|bmp|tiff?|mp4|mov|avi|mkv|webm|mp3|wav|m4a|ogg|flac|zip|rar|7z|tar|gz|tgz|eml|msg|ics|vcf|sqlite|db";
const FILE_NAME = new RegExp(String.raw`(?<![\p{L}\p{N}_.<-])[\p{L}\p{N}_][\p{L}\p{N}_.()&+,'-]{0,120}\.(${FILE_TYPES})(?![\p{L}\p{N}_])`, "giu");
/** Seira's own code inside an absolute path: what follows it stays, so a stack frame still points at a source file. */
const SEIRA_CODE = /[\\/]((?:server|src|shared|packages|dist-server|dist)[\\/][^\s"'`()<>,;]+)$/;
/** A folder may hold single spaces ("Klien Sinta/"), and so may a last part that ends in a file type ("budget 2027.docx"). */
const ABSOLUTE_PATH = /(?:\b[A-Za-z]:[\\/]|~[\\/]|(?<![\w.:/-])\/)(?:[^\s"'`()<>,;:\\/]+(?: [^\s"'`()<>,;:\\/]+)*[\\/])*[^\s"'`()<>,;:\\/]+(?:(?: [^\s"'`()<>,;:\\/]+)*\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9_]))?/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>«»]+/gi;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Pieces of a person's message long enough to recognise: its lines and sentences. */
function fragments(message: string): string[] {
  return message.split(/\r?\n|(?<=[.!?])\s+/).map((part) => part.trim()).filter((part) => part.length >= 12);
}

/** The @devs redaction, then every name, address, path, file name and piece of the person's own words, removed. */
export function cleanReportText(text: string, words: { names?: readonly string[]; messages?: readonly string[]; secrets?: readonly string[] } = {}): string {
  let out = redactReportText(text, words.secrets);
  for (const message of words.messages ?? []) {
    for (const part of [message.trim(), ...fragments(message)]) if (part.length >= 12 && out.includes(part)) out = out.split(part).join("«message text»");
  }
  out = out.replace(URL_IN_TEXT, (url) => { try { return `${new URL(url).origin}/…`; } catch { return "«link»"; } });
  out = out.replace(EMAIL, "<email>");
  out = out.replace(ABSOLUTE_PATH, (path) => {
    const code = SEIRA_CODE.exec(path);
    if (code) return code[1]!.replace(/\\/g, "/");
    const last = path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
    const type = /\.([A-Za-z0-9]{1,8})$/.exec(last)?.[1];
    return type ? `<file>.${type}` : "<path>";
  });
  out = out.replace(FILE_NAME, (_name, type: string) => `<file>.${type}`);
  const names = [...new Set((words.names ?? []).map((name) => name.trim()).filter((name) => name.length >= 2 && name.toLowerCase() !== "seira"))].sort((a, b) => b.length - a.length);
  for (const name of names) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "giu"), "<name>");
  return out;
}

/** The step's name as the report shows it: Seira's tools and the engine's own by name, a connected app's tool only as that. */
function shownStep(tool: string): string {
  if (!tool) return "a step";
  if (isSeiraTool(tool)) return stepName(tool);
  return /^mcp__|__/.test(tool) ? "a connected app's tool" : oneLine(tool, 60);
}

const firstLine = (text: string) => text.split("\n").find((line) => line.trim() && !/^\s*at\s/.test(line))?.trim() ?? "";

export function buildOfferReport(input: OfferReportInput, secrets?: readonly string[]): OfferReport {
  const clean = (text: string) => cleanReportText(text, { names: input.names, messages: input.messages, secrets });
  const error = clean(input.error.text);
  const facts: ErrorFacts = { ...input.error, text: error };
  const fingerprint = errorFingerprint(facts);
  const hash = createHash("sha256").update(`${fingerprint.kind}\n${fingerprint.step ?? ""}\n${fingerprint.frame ?? ""}`).digest("hex").slice(0, 16);
  const step = input.where === "step" ? shownStep(input.error.tool ?? "") : "";
  const head = firstLine(error).replace(/^(?:Uncaught\s+)?\w*Error:\s*/, "") || "an error inside Seira";

  const title = clip(input.where === "step" ? `Step ${step} fails: ${head}` : input.where === "turn" ? `A turn stops: ${head}` : `A request fails: ${head}`, LIMITS.title);
  const happened = input.where === "step"
    ? `The bot was working on a task when one of its steps stopped with an error inside Seira.${input.recovered ? " The bot went on and finished the task another way." : ""}`
    : input.where === "turn" ? "The bot was working on a task when its turn stopped with an error inside Seira. The task did not finish."
      : "A request in the app stopped with an error inside Seira.";
  const description = [happened, "", `What went wrong: ${input.where === "step" ? `step ${step} failed.` : input.where === "turn" ? "the turn stopped." : "the request failed."}`, head].join("\n");

  const steps = input.steps.slice(-LIMITS.steps).map((one, index) => `${index + 1}. ${shownStep(one.tool)} · ${one.ok ? "done" : "failed"}`);
  const problems = input.problems.slice(-LIMITS.problems).map((line) => oneLine(clean(line), LIMITS.line));
  const log = input.log.slice(-LIMITS.log).map((line) => oneLine(clean(line), LIMITS.line));
  const engine = input.engine ? `${clean(input.engine.name)} · model ${clean(input.engine.model) || "default"}${input.engine.health ? ` (${clean(input.engine.health)})` : ""}` : "unknown";
  const diagnostics = [
    "Seira bug report, offered after an error",
    `App version: ${input.appVersion}`, `Runs on: ${input.runsOn}`, `OS: ${input.os}`, `Node: ${input.node}`,
    ...(input.language ? [`Language: ${input.language}`] : []), `AI: ${engine}`,
    "", "## Error", ...error.split("\n").slice(0, LIMITS.errorLines).map((line) => oneLine(line, LIMITS.line)),
    ...(steps.length ? ["", "## Steps in this turn", ...steps] : []),
    "", "## Recent problems in this conversation, newest last", ...(problems.length ? problems : ["(none)"]),
    "", "## Server warnings and errors, newest last", ...(log.length ? log : ["(none since the server started)"]),
  ].join("\n");

  const payload: DevsReportPayload = {
    installId: input.installId,
    source: "bot",
    description,
    appVersion: oneLine(input.appVersion, LIMITS.field) || "unknown",
    platform: oneLine(input.platform, LIMITS.field) || "unknown",
    diagnostics,
    title,
    fingerprint,
  };
  return { payload, title, fingerprint, hash, activity: problems.length + log.length, ...(input.engine?.model ? { model: clean(input.engine.model) } : {}) };
}

/** A @devs report as a public issue: no address, no install id, and names, paths, addresses and file names cleaned out of
 * the diagnostics. The person's own words and the bot's summary stay: the person reads them before they send. Unless
 * `whole` (the person who runs the app), only this conversation's part of the diagnostics stays: the rest is server-wide. */
export function publicDevsReport(payload: DevsReportPayload, secrets?: readonly string[], options: { names?: readonly string[]; whole?: boolean } = {}): DevsReportPayload {
  const { contactEmail: _email, contact: _contact, ...rest } = payload;
  const kept = options.whole ? rest.diagnostics : conversationDiagnostics(rest.diagnostics);
  const diagnostics = kept.split("\n").filter((line) => !/^\s*Install:\s/.test(line)).join("\n");
  // The title is its own public field: it gets the same secret redaction first, then the names, hosts and paths of the title rules.
  const title = cleanTitle(rest.title, { redact: (text) => redactReportText(text, secrets), names: [...(options.names ?? []), rest.installId], max: LIMITS.title, sentence: false }) || GENERIC_REPORT_TITLE;
  return { ...rest, title, diagnostics: cleanReportText(diagnostics, { names: options.names ?? [], secrets }) };
}
