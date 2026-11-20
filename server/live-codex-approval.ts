import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { spokenConsent } from "../shared/call-consent.ts";
import { CONSENT_SETTLE_MS } from "./live-call-controller.ts";

export type LiveCodexApprovalOutcome = "accept" | "decline" | "timeout";

/** One file that a change request touches. `kind` is null when Codex does not name it. */
export interface LiveCodexFileChange {
  path: string;
  kind: "add" | "delete" | "update" | null;
  movePath: string | null;
}

export interface LiveCodexApprovalOptions {
  speak(text: string): void;
  onOutcome(outcome: LiveCodexApprovalOutcome): void;
  timeoutMs: number;
  /** Thread of the call. A request for another thread is declined. */
  threadId(): string | null;
  /** Working folder of the call. File paths are spoken relative to its real path. Without it, each file change is declined. */
  cwd?: string;
  /** Changes that a file change request makes, or null when unknown. */
  files?(params: Record<string, unknown>): LiveCodexFileChange[] | null;
  /** Quiet time after a final transcript before it is read as an answer. */
  settleMs?: number;
  /** Speaking rate that estimates when the voice's audio ends. */
  spokenCharsPerSecond?: number;
  /** Time after the estimated audio end in which user speech can still be the voice's echo. */
  echoTailMs?: number;
}

export interface LiveCodexApproval {
  /** True when the method is an approval request. The request is then answered through `respond`. */
  request(method: string, params: unknown, respond: (result: unknown) => void): boolean;
  /** One user transcript delta. The first delta of an utterance binds it to the question the person heard, if any. */
  userSpeech(): void;
  /** The final user transcript of one utterance. */
  heard(text: string): void;
  /** One transcript delta of the voice. The first delta of an output marks when its audio started. */
  voiceSpeech(): void;
  /** The final transcript of one voice output. */
  voiceDone(text: string): void;
  /** Decline an open request without an outcome. */
  dispose(): void;
}

export const COMMAND_SPOKEN_LIMIT = 120;
export const FILES_SPOKEN_LIMIT = 3;
export const PATH_SPOKEN_LIMIT = 80;
/** About 150 words a minute. Realtime voices speak a little faster, so the estimate errs long. */
export const SPOKEN_CHARS_PER_SECOND = 14;
/** Playback buffer and transcription delay of the voice's audio heard back through the microphone. */
export const ECHO_TAIL_MS = 800;
const ANSWER_HINT = "Should I go ahead? Say yes or no.";
const NOTICE_COMMAND = "I need to run a command that I cannot read out in full, so I did not run it. Ask me in the chat to run it.";
const NOTICE_PERMISSIONS = "I need more access than I have now, so I did not do it. Ask me in the chat to allow it.";
const NOTICE_FILES = "I need to change files that I cannot read out in full, so I did not change them. Ask me in the chat to change them.";
const SEPARATORS = /[;|&`<>\n\r]|\$\(/;
/** Printable ASCII only. A voice does not read out control or format characters, and letters that look alike sound alike. */
const SPOKEN_COMMAND = /^[\x20-\x7e]+$/;
const SPOKEN_PATH = /^[A-Za-z0-9._ /-]+$/;
/** Repository internals, credentials and agent settings: a change there is never approved by voice. */
const PROTECTED_SEGMENT = /^\.(?:git|ssh|codex|env)/i;
const VERBS = { add: "create", delete: "delete", update: "change" } as const;
const MIN_ECHO_WORDS = 3;

type Kind = "command" | "files" | "permissions";

const KINDS: Record<string, { kind: Kind; legacy: boolean }> = {
  "item/commandExecution/requestApproval": { kind: "command", legacy: false },
  "item/fileChange/requestApproval": { kind: "files", legacy: false },
  "item/permissions/requestApproval": { kind: "permissions", legacy: false },
  execCommandApproval: { kind: "command", legacy: true },
  applyPatchApproval: { kind: "files", legacy: true },
};

/** Phrases that a voice output must each say in full before it counts as the question. */
type Subject = string[];

interface OpenRequest {
  question: string;
  subject: Subject;
  spoken: boolean;
  settle(allow: boolean, outcome: LiveCodexApprovalOutcome | null): void;
}

interface VoiceOutput {
  startedAt: number;
  /** The open request whose question this output can be, when the output started after the request opened. */
  asks: OpenRequest | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** One change of a `fileChange` item (`path`, `kind`) or of a legacy `fileChanges` entry (key, value), or null when malformed. */
export function fileChangeOf(path: unknown, kind: unknown): LiveCodexFileChange | null {
  if (typeof path !== "string" || !path) return null;
  const fields = isRecord(kind) ? kind : {};
  const moved = fields.move_path;
  const movePath = typeof moved === "string" && moved ? moved : null;
  if (moved != null && movePath === null) return null;
  const type = fields.type;
  return { path, kind: type === "add" || type === "delete" || type === "update" ? type : null, movePath };
}

function legacyFileChanges(raw: Record<string, unknown>): LiveCodexFileChange[] | null {
  const changes = Object.entries(raw).map(([path, change]) => fileChangeOf(path, change));
  return changes.includes(null) ? null : changes as LiveCodexFileChange[];
}

function commandText(params: Record<string, unknown>): string {
  const raw = params.command;
  return Array.isArray(raw) ? raw.filter((part) => typeof part === "string").join(" ") : typeof raw === "string" ? raw : "";
}

function grantedPermissions(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== null && value !== undefined));
}

function reply(method: string, params: Record<string, unknown>, allow: boolean): unknown {
  const { kind, legacy } = KINDS[method]!;
  if (kind === "permissions") return { permissions: allow ? grantedPermissions(params.permissions) : {}, scope: "turn" };
  return { decision: allow ? (legacy ? "approved" : "accept") : legacy ? "denied" : "decline" };
}

const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
const spokenForm = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const QUOTES = "[\"'`)]*";

/** The voice's own question, heard again through the microphone. */
function isEcho(heard: string, question: string): boolean {
  const said = words(heard);
  if (said.length < MIN_ECHO_WORDS) return false;
  const asked = ` ${words(question).join(" ")} `;
  return asked.includes(` ${said.join(" ")} `);
}

/**
 * True when the output says the phrase in full, with only case and spacing changed. The phrase must start a word,
 * and the output or a clause must end right after it: a word or flag that follows changes what the person hears.
 */
function saysInFull(output: string, phrase: string): boolean {
  const end = `${QUOTES}(?:$|[.,;:!?]+${QUOTES}(?:\\s|$))`;
  return new RegExp(`(?:^|[\\s"'\`(])${escapeRegExp(spokenForm(phrase))}${end}`).test(spokenForm(output));
}

const namesSubject = (output: string, subject: Subject) => subject.length > 0 && subject.every((phrase) => saysInFull(output, phrase));

const realFolder = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/**
 * The target with each existing folder on its way resolved through symlinks, or null when the target
 * itself is a symlink or the file system cannot answer. Codex asks for approval when the real path
 * leaves the writable roots, so a symlink inside the working folder must not hide where a write lands.
 */
function realTarget(target: string): string | null {
  try {
    if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) return null;
    const missing: string[] = [];
    let existing = target;
    while (!lstatSync(existing, { throwIfNoEntry: false })) {
      const parent = dirname(existing);
      if (parent === existing) return null;
      missing.unshift(basename(existing));
      existing = parent;
    }
    return join(realpathSync(existing), ...missing);
  } catch {
    return null;
  }
}

const isProtected = (path: string) => path.split(sep).some((segment) => PROTECTED_SEGMENT.test(segment));

/** The real path relative to the real working folder, as the voice says it, or null when a voice must not approve it. */
function spokenPath(raw: string, cwd: string, realCwd: string): string | null {
  if (raw.split(/[\\/]/).includes("..")) return null;
  const target = resolve(cwd, raw);
  const real = realTarget(target);
  if (real === null || isProtected(relative(cwd, target))) return null;
  const inside = relative(realCwd, real);
  if (!inside || inside.startsWith("..") || isAbsolute(inside) || isProtected(inside)) return null;
  const spoken = inside.split(sep).join("/");
  return spoken.length <= PATH_SPOKEN_LIMIT && SPOKEN_PATH.test(spoken) ? spoken : null;
}

function filesQuestion(changes: LiveCodexFileChange[] | null, cwd: string | undefined): { question: string; subject: Subject } | null {
  if (!changes?.length || changes.length > FILES_SPOKEN_LIMIT || !cwd) return null;
  const realCwd = realFolder(cwd);
  if (realCwd === null) return null;
  const spoken: Array<{ verb: string; path: string; to: string | null }> = [];
  for (const change of changes) {
    const path = spokenPath(change.path, cwd, realCwd);
    const to = change.movePath === null ? null : spokenPath(change.movePath, cwd, realCwd);
    if (path === null || (change.movePath !== null && to === null)) return null;
    spoken.push({ verb: to ? "move" : VERBS[change.kind ?? "update"], path, to });
  }
  const subject = spoken.map(({ verb, path, to }) => (to ? `${verb} ${path} to ${to}` : `${verb} ${path}`));
  const list = subject.join(", ");
  const question = subject.length === 1 ? `I need your OK to ${list}.` : `I need your OK for these file changes: ${list}.`;
  return { question: `${question} ${ANSWER_HINT}`, subject };
}

function questionFor(
  kind: Kind,
  fields: Record<string, unknown>,
  options: LiveCodexApprovalOptions,
): { question: string; subject: Subject } | { notice: string } {
  if (kind === "permissions" || fields.additionalPermissions != null || fields.networkApprovalContext != null || fields.grantRoot != null) {
    return { notice: NOTICE_PERMISSIONS };
  }
  if (kind === "command") {
    const command = commandText(fields);
    const plain = fields.kind == null || fields.kind === "command";
    if (!plain || !command.trim() || command.length > COMMAND_SPOKEN_LIMIT || SEPARATORS.test(command) || !SPOKEN_COMMAND.test(command)) return { notice: NOTICE_COMMAND };
    return { question: `I need your OK to run this command: ${command}. ${ANSWER_HINT}`, subject: [command] };
  }
  const changes = isRecord(fields.fileChanges) ? legacyFileChanges(fields.fileChanges) : options.files?.(fields) ?? null;
  return filesQuestion(changes, options.cwd) ?? { notice: NOTICE_FILES };
}

export function createLiveCodexApproval(options: LiveCodexApprovalOptions): LiveCodexApproval {
  const settleMs = options.settleMs ?? CONSENT_SETTLE_MS;
  const charsPerSecond = options.spokenCharsPerSecond ?? SPOKEN_CHARS_PER_SECOND;
  const echoTailMs = options.echoTailMs ?? ECHO_TAIL_MS;
  let open: OpenRequest | null = null;
  let voice: VoiceOutput | null = null;
  let voiceQuietAt = 0;
  let utterance: { request: OpenRequest | null } | null = null;
  let pending: { request: OpenRequest; text: string } | null = null;
  let settleTimer: NodeJS.Timeout | null = null;

  const clearSettle = () => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
  };
  const startVoice = (): VoiceOutput => ({ startedAt: Date.now(), asks: open && !open.spoken ? open : null });
  /** The open request, once the person has heard its question and the voice's echo has passed. */
  const answerable = (): OpenRequest | null => (open?.spoken && voice === null && Date.now() >= voiceQuietAt ? open : null);

  return {
    request(method, params, respond) {
      const entry = KINDS[method];
      if (!entry) return false;
      const fields = isRecord(params) ? params : {};
      const decline = (outcome: LiveCodexApprovalOutcome | null, notice?: string) => {
        respond(reply(method, fields, false));
        if (outcome) options.onOutcome(outcome);
        if (notice) options.speak(notice);
      };
      const thread = fields.threadId ?? fields.conversationId;
      if (typeof thread !== "string" || thread !== options.threadId()) {
        decline(null);
        return true;
      }
      if (open) {
        decline("decline");
        return true;
      }
      const asked = questionFor(entry.kind, fields, options);
      if ("notice" in asked) {
        decline("decline", asked.notice);
        return true;
      }

      let done = false;
      const timer = setTimeout(() => current.settle(false, "timeout"), options.timeoutMs);
      timer.unref?.();
      const current: OpenRequest = {
        question: asked.question,
        subject: asked.subject,
        spoken: false,
        settle(allow, outcome) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          clearSettle();
          pending = null;
          if (open === current) open = null;
          respond(reply(method, fields, allow));
          if (outcome) options.onOutcome(outcome);
        },
      };
      open = current;
      options.speak(asked.question);
      return true;
    },
    userSpeech() {
      clearSettle();
      if (utterance) return;
      const request = answerable();
      utterance = { request };
      if (pending?.request !== request) pending = null;
    },
    heard(text) {
      const request = utterance?.request ?? null;
      utterance = null;
      if (!request || request !== open || !text.trim() || isEcho(text, request.question)) return;
      pending = { request, text: pending?.request === request ? `${pending.text} ${text}` : text };
      clearSettle();
      settleTimer = setTimeout(() => {
        settleTimer = null;
        const said = pending;
        pending = null;
        if (!said || said.request !== open) return;
        const decision = spokenConsent(said.text, "live");
        if (decision !== null) said.request.settle(decision === "allow", decision === "allow" ? "accept" : "decline");
      }, settleMs);
      settleTimer.unref?.();
    },
    voiceSpeech() {
      voice ??= startVoice();
    },
    voiceDone(text) {
      const output = voice ?? startVoice();
      voice = null;
      const chars = Math.max(text.length, output.asks?.question.length ?? 0);
      const audioEnd = Math.max(Date.now(), output.startedAt + Math.ceil((chars * 1_000) / charsPerSecond));
      voiceQuietAt = Math.max(voiceQuietAt, audioEnd + echoTailMs);
      if (output.asks && namesSubject(text, output.asks.subject)) output.asks.spoken = true;
    },
    dispose() {
      clearSettle();
      pending = null;
      open?.settle(false, null);
    },
  };
}
