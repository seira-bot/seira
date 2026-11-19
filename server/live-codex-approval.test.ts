import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createLiveCodexApproval,
  ECHO_TAIL_MS,
  SPOKEN_CHARS_PER_SECOND,
  type LiveCodexApprovalOptions,
  type LiveCodexFileChange,
  type LiveCodexApprovalOutcome,
} from "./live-codex-approval.ts";

const COMMAND = "item/commandExecution/requestApproval";
const FILES = "item/fileChange/requestApproval";
const PERMISSIONS = "item/permissions/requestApproval";
const THREAD = "thread-1";
const SETTLE = 1_200;
const LS_QUESTION = "I need your OK to run this command: ls -la. Should I go ahead? Say yes or no.";
const NOTICE_COMMAND = "I need to run a command that I cannot read out in full, so I did not run it. Ask me in the chat to run it.";
const NOTICE_FILES = "I need to change files that I cannot read out in full, so I did not change them. Ask me in the chat to change them.";
const NOTICE_PERMISSIONS = "I need more access than I have now, so I did not do it. Ask me in the chat to allow it.";

const ROOT = mkdtempSync(join(tmpdir(), "live-approval-"));
const OUTSIDE = mkdtempSync(join(tmpdir(), "live-approval-outside-"));
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
});

const audioMs = (text: string) => Math.ceil((text.length * 1_000) / SPOKEN_CHARS_PER_SECOND);
const change = (path: string, kind: LiveCodexFileChange["kind"] = "update", movePath: string | null = null): LiveCodexFileChange => ({ path, kind, movePath });

function setup(extra: Partial<LiveCodexApprovalOptions> = {}) {
  const spoken: string[] = [];
  const outcomes: LiveCodexApprovalOutcome[] = [];
  const approval = createLiveCodexApproval({
    speak: (text) => spoken.push(text),
    onOutcome: (outcome) => outcomes.push(outcome),
    timeoutMs: 60_000,
    threadId: () => THREAD,
    cwd: ROOT,
    ...extra,
  });
  const respond = vi.fn();
  /** The voice speaks the text at once, then its estimated audio and the echo tail pass. */
  const voiceSays = (text = spoken.at(-1) ?? "") => {
    approval.voiceSpeech();
    approval.voiceDone(text);
    vi.advanceTimersByTime(audioMs(text) + ECHO_TAIL_MS);
  };
  const open = (command = "ls -la", reply = respond) => approval.request(COMMAND, { threadId: THREAD, command }, reply);
  /** Open a command request, and let the voice speak what it asks. */
  const ask = (command = "ls -la") => {
    const handled = open(command);
    voiceSays();
    return handled;
  };
  /** One whole utterance: a delta, then the final text, then the settle window. */
  const say = (text: string, settle = SETTLE) => {
    approval.userSpeech();
    approval.heard(text);
    vi.advanceTimersByTime(settle);
  };
  return { approval, spoken, outcomes, respond, open, ask, say, voiceSays };
}

/** Open a file change request whose item makes these changes. */
function askFiles(changes: LiveCodexFileChange[], extra: Partial<LiveCodexApprovalOptions> = {}) {
  const harness = setup({ files: () => changes, ...extra });
  harness.approval.request(FILES, { threadId: THREAD, itemId: "call-1" }, harness.respond);
  return harness;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("live Codex approval by voice", () => {
  it("asks about a command and accepts on a clear yes after the settle window", () => {
    const { approval, spoken, outcomes, respond, ask, say } = setup();
    expect(ask()).toBe(true);
    expect(spoken).toEqual([LS_QUESTION]);
    approval.userSpeech();
    approval.heard("Yes.");
    vi.advanceTimersByTime(SETTLE - 1);
    expect(respond).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "accept" });
    expect(outcomes).toEqual(["accept"]);
    say("yes");
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("declines on a clear no", () => {
    const { outcomes, respond, ask, say } = setup();
    ask("rm -rf scratch");
    say("no, don't");
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(outcomes).toEqual(["decline"]);
  });

  it("keeps waiting on words that are not a clear answer", () => {
    const { outcomes, respond, ask, say } = setup();
    ask("ls");
    say("wait, what does it delete?");
    say("okay");
    expect(respond).not.toHaveBeenCalled();
    say("yes");
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "accept" });
    expect(outcomes).toEqual(["accept"]);
  });

  it("uses a transcript for one decision only", () => {
    const { approval, respond, ask, say, voiceSays } = setup();
    ask("ls");
    say("yes");
    const second = vi.fn();
    approval.request(COMMAND, { threadId: THREAD, command: "pwd" }, second);
    voiceSays();
    approval.heard("yes");
    vi.advanceTimersByTime(SETTLE);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("holds the decision while the person keeps talking", () => {
    const { approval, respond, ask, say } = setup();
    ask("ls");
    say("yes", SETTLE - 100);
    approval.userSpeech();
    vi.advanceTimersByTime(5_000);
    expect(respond).not.toHaveBeenCalled();
  });

  it("drops a pending yes when the person speaks over the voice before the decision", () => {
    const { approval, respond, ask, say } = setup();
    ask("rm -rf build");
    say("yes", SETTLE - 100);
    approval.voiceSpeech();
    say("no, wait", SETTLE * 2);
    expect(respond).not.toHaveBeenCalled();
  });

  it("declines and reports a timeout when no clear answer comes", () => {
    const { outcomes, respond, open, voiceSays, say } = setup({ timeoutMs: 60_000 });
    open();
    voiceSays();
    vi.advanceTimersByTime(60_000 - audioMs(LS_QUESTION) - ECHO_TAIL_MS - 1);
    expect(respond).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(outcomes).toEqual(["timeout"]);
    say("yes");
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("declines a second request at once and keeps the first open", () => {
    const { approval, outcomes, respond, spoken, ask, say } = setup();
    const second = vi.fn();
    ask("first");
    expect(approval.request(COMMAND, { threadId: THREAD, command: "second" }, second)).toBe(true);
    expect(second).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(outcomes).toEqual(["decline"]);
    expect(spoken).toHaveLength(1);
    expect(respond).not.toHaveBeenCalled();
    say("yes");
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "accept" });
  });

  it("uses the legacy answers for the legacy requests", () => {
    const yes = setup();
    const accepted = vi.fn();
    yes.approval.request("execCommandApproval", { conversationId: THREAD, command: ["git", "status"] }, accepted);
    expect(yes.spoken[0]).toContain("git status");
    yes.voiceSays();
    yes.say("yes");
    expect(accepted).toHaveBeenCalledExactlyOnceWith({ decision: "approved" });

    const no = setup();
    const refused = vi.fn();
    no.approval.request("applyPatchApproval", { conversationId: THREAD, fileChanges: { "a.ts": {} } }, refused);
    no.voiceSays();
    no.say("no");
    expect(refused).toHaveBeenCalledExactlyOnceWith({ decision: "denied" });
  });

  it("leaves other methods alone", () => {
    const { approval, spoken, respond } = setup();
    expect(approval.request("item/tool/requestUserInput", {}, respond)).toBe(false);
    expect(approval.request("mcpServer/elicitation/request", {}, respond)).toBe(false);
    expect(respond).not.toHaveBeenCalled();
    expect(spoken).toEqual([]);
  });

  it("ignores speech when nothing is open", () => {
    const { outcomes, say } = setup();
    say("yes");
    expect(outcomes).toEqual([]);
  });

  it("declines an open request on dispose without an outcome", () => {
    const { approval, outcomes, respond, ask } = setup();
    ask();
    approval.dispose();
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(outcomes).toEqual([]);
    vi.advanceTimersByTime(120_000);
    expect(respond).toHaveBeenCalledTimes(1);
  });
});

describe("live Codex approval answers only the question the person heard", () => {
  it("ignores a yes that began before the voice spoke the question", () => {
    const { approval, respond, outcomes, open, say, voiceSays } = setup();
    open("rm -rf build");
    approval.userSpeech();
    approval.heard("Yes, do it.");
    vi.advanceTimersByTime(SETTLE);
    say("yes");
    expect(respond).not.toHaveBeenCalled();
    expect(outcomes).toEqual([]);
    voiceSays();
    say("yes");
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "accept" });
    expect(outcomes).toEqual(["accept"]);
  });

  it("ignores an utterance that began before the question and ended after it", () => {
    const { approval, respond, open, voiceSays } = setup();
    open();
    approval.userSpeech();
    voiceSays();
    approval.heard("yes");
    vi.advanceTimersByTime(SETTLE);
    expect(respond).not.toHaveBeenCalled();
  });

  it("does not take an answer that began before the request", () => {
    const { approval, respond, ask } = setup();
    approval.userSpeech();
    ask();
    approval.heard("yes");
    vi.advanceTimersByTime(SETTLE);
    expect(respond).not.toHaveBeenCalled();
  });

  it("takes the next answer after a stale one", () => {
    const { approval, respond, ask, say } = setup();
    approval.userSpeech();
    ask();
    approval.heard("yes");
    say("no");
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
  });

  it("does not count a voice output that began before the request as the question", () => {
    const { approval, spoken, respond, open, say, voiceSays } = setup();
    approval.voiceSpeech();
    open();
    approval.voiceDone("Sure, I will check the build.");
    vi.advanceTimersByTime(10_000);
    say("yes");
    expect(respond).not.toHaveBeenCalled();
    voiceSays(spoken[0]);
    say("yes");
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "accept" });
  });

  it("ignores speech while the voice still speaks", () => {
    const { approval, respond, open, say } = setup();
    open();
    approval.voiceSpeech();
    vi.advanceTimersByTime(30_000);
    say("yes");
    expect(respond).not.toHaveBeenCalled();
  });

  it("opens the answer window for the ls -la question 6.3 s after the voice starts it", () => {
    expect(audioMs(LS_QUESTION) + ECHO_TAIL_MS).toBe(6_300);
  });

  it.each([
    ["the audio estimate", 500, -1, false],
    ["the audio estimate", 500, 0, true],
    ["the final transcript", 9_000, -1, false],
    ["the final transcript", 9_000, 0, true],
  ])("opens the answer window at %s plus the echo tail (done after %d ms, offset %d ms)", (_end, doneAfter, offset, taken) => {
    const { approval, spoken, respond, open } = setup();
    open();
    const startedAt = Date.now();
    approval.voiceSpeech();
    vi.advanceTimersByTime(doneAfter);
    approval.voiceDone(spoken[0]!);
    const audioEnd = startedAt + Math.max(doneAfter, audioMs(spoken[0]!));
    vi.advanceTimersByTime(audioEnd + ECHO_TAIL_MS + offset - Date.now());
    approval.userSpeech();
    approval.heard("yes");
    vi.advanceTimersByTime(SETTLE);
    expect(respond.mock.calls).toEqual(taken ? [[{ decision: "accept" }]] : []);
  });

  it.each(["yes", "Allow it.", "go ahead", "Say yes or no."])("ignores %j heard inside the echo window", (echo) => {
    const { approval, spoken, outcomes, respond, open, say } = setup();
    open();
    approval.voiceSpeech();
    approval.voiceDone(spoken[0]!);
    vi.advanceTimersByTime(audioMs(spoken[0]!) + ECHO_TAIL_MS / 2);
    say(echo);
    expect(respond).not.toHaveBeenCalled();
    expect(outcomes).toEqual([]);
    say("yes");
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "accept" });
  });

  it("ignores the question heard again through the microphone after the window", () => {
    const { spoken, respond, outcomes, ask, say } = setup();
    ask("ls -la");
    say("I need your OK to run this command ls la. Should I go ahead? Say yes or no.");
    say("should I go ahead say yes or no");
    expect(respond).not.toHaveBeenCalled();
    expect(outcomes).toEqual([]);
    expect(spoken).toHaveLength(1);
    say("yes");
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "accept" });
  });

  it("never lets an utterance that began under one request answer the next", () => {
    const { approval, outcomes, ask, say, voiceSays } = setup({ timeoutMs: 20_000 });
    ask("ls");
    approval.userSpeech();
    vi.advanceTimersByTime(20_000);
    expect(outcomes).toEqual(["timeout"]);
    const second = vi.fn();
    approval.request(COMMAND, { threadId: THREAD, command: "rm -rf build" }, second);
    voiceSays();
    approval.heard("yes");
    vi.advanceTimersByTime(SETTLE);
    expect(second).not.toHaveBeenCalled();
    say("yes");
    expect(second).toHaveBeenCalledExactlyOnceWith({ decision: "accept" });
  });

  it("settles only the request that the pending answer was for", () => {
    const question = "I need your OK to run this command: ls. Should I go ahead? Say yes or no.";
    const { approval, spoken, outcomes, respond, ask } = setup({ timeoutMs: audioMs(question) + ECHO_TAIL_MS + SETTLE / 2 });
    ask("ls");
    expect(spoken).toEqual([question]);
    approval.userSpeech();
    approval.heard("yes");
    vi.advanceTimersByTime(SETTLE / 2);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(outcomes).toEqual(["timeout"]);
    const second = vi.fn();
    approval.request(COMMAND, { threadId: THREAD, command: "rm -rf build" }, second);
    vi.advanceTimersByTime(SETTLE * 2);
    expect(second).not.toHaveBeenCalled();
    expect(outcomes).toEqual(["timeout"]);
  });

  it("declines a request for another thread without a question or an outcome", () => {
    const { approval, spoken, outcomes, respond } = setup();
    approval.request(COMMAND, { threadId: "other", command: "ls" }, respond);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(spoken).toEqual([]);
    expect(outcomes).toEqual([]);
  });

  it("declines a request with no thread or before the thread is known", () => {
    const a = setup();
    a.approval.request(COMMAND, { command: "ls" }, a.respond);
    expect(a.respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    const b = setup({ threadId: () => null });
    b.approval.request(COMMAND, { threadId: THREAD, command: "ls" }, b.respond);
    expect(b.respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(b.spoken).toEqual([]);
  });
});

describe("live Codex approval never grants wider access by voice", () => {
  it.each([
    ["network access", { networkApprovalContext: { host: "example.com", protocol: "https" } }],
    ["more permissions", { additionalPermissions: { network: { enabled: true } } }],
  ])("declines at once a command that asks for %s", (_name, extra) => {
    const { approval, spoken, outcomes, respond, say, voiceSays } = setup();
    approval.request(COMMAND, { threadId: THREAD, command: "curl example.com", ...extra }, respond);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(outcomes).toEqual(["decline"]);
    expect(spoken).toEqual([NOTICE_PERMISSIONS]);
    voiceSays();
    say("yes");
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("declines a legacy command that asks for more permissions", () => {
    const { approval, spoken, respond } = setup();
    approval.request("execCommandApproval", { conversationId: THREAD, command: ["ls"], additionalPermissions: { network: { enabled: true } } }, respond);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "denied" });
    expect(spoken).toEqual([NOTICE_PERMISSIONS]);
  });

  it("asks about a command whose wider access fields are null", () => {
    const { approval, spoken, respond } = setup();
    approval.request(COMMAND, { threadId: THREAD, command: "ls -la", additionalPermissions: null, networkApprovalContext: null }, respond);
    expect(respond).not.toHaveBeenCalled();
    expect(spoken).toEqual([LS_QUESTION]);
  });

  it("always declines a permissions request and never grants it", () => {
    const { approval, spoken, outcomes, respond, say, voiceSays } = setup();
    approval.request(PERMISSIONS, { threadId: THREAD, permissions: { network: { enabled: true } } }, respond);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ permissions: {}, scope: "turn" });
    expect(outcomes).toEqual(["decline"]);
    expect(spoken).toEqual([NOTICE_PERMISSIONS]);
    voiceSays();
    say("yes");
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("declines a file change that widens the writable root", () => {
    const { approval, spoken, respond } = setup({ files: () => [change(`${ROOT}/x.ts`)] });
    approval.request(FILES, { threadId: THREAD, grantRoot: ROOT }, respond);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(spoken).toEqual([NOTICE_PERMISSIONS]);
  });
});

describe("live Codex approval spoken question limits", () => {
  it("declines at once a command over 120 characters", () => {
    const { spoken, outcomes, respond, open } = setup();
    open(`echo ${"x".repeat(116)}`);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(outcomes).toEqual(["decline"]);
    expect(spoken).toEqual([NOTICE_COMMAND]);
  });

  it("asks about a command of exactly 120 characters", () => {
    const { spoken, respond, open } = setup();
    open(`echo ${"x".repeat(115)}`);
    expect(respond).not.toHaveBeenCalled();
    expect(spoken[0]).toContain("Say yes or no.");
  });

  it.each([
    ["a newline", "ls\nrm -rf x"],
    ["a semicolon", "ls; rm -rf x"],
    ["and", "ls && rm -rf x"],
    ["or", "ls || rm -rf x"],
    ["a pipe", "ls | sh"],
    ["a background marker", "sleep 9 &"],
    ["a backtick", "echo `id`"],
    ["a substitution", "echo $(id)"],
    ["an output redirect", "echo x > ~/.bashrc"],
    ["an input redirect", "sh < script"],
  ])("declines at once a command with %s", (_name, command) => {
    const { spoken, outcomes, respond, open } = setup();
    open(command);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(outcomes).toEqual(["decline"]);
    expect(spoken).toEqual([NOTICE_COMMAND]);
  });

  it("declines a command with no text", () => {
    const { spoken, respond, open } = setup();
    open("");
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(spoken).toEqual([NOTICE_COMMAND]);
  });

  it.each(["writeStdin", "humanCommand"])("declines a %s request with the command notice", (kind) => {
    const { approval, spoken, respond } = setup();
    approval.request(COMMAND, { threadId: THREAD, command: "ls", kind }, respond);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(spoken).toEqual([NOTICE_COMMAND]);
  });

  it("joins a legacy command list into one spoken command", () => {
    const { spoken, approval, respond } = setup();
    approval.request("execCommandApproval", { conversationId: THREAD, command: ["git", "log", "-1"] }, respond);
    expect(spoken).toEqual(["I need your OK to run this command: git log -1. Should I go ahead? Say yes or no."]);
  });

  it("speaks up to three paths relative to the working folder and asks", () => {
    const { spoken, respond, approval, say, voiceSays } = setup();
    approval.request("applyPatchApproval", { conversationId: THREAD, fileChanges: { [`${ROOT}/src/a.ts`]: {}, [`${ROOT}/b.ts`]: {}, "c.ts": {} } }, respond);
    expect(spoken).toEqual(["I need your OK for these file changes: change src/a.ts, change b.ts, change c.ts. Should I go ahead? Say yes or no."]);
    voiceSays();
    say("yes");
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "approved" });
  });

  it("asks about a file change with known names and accepts a yes", () => {
    const files = vi.fn(() => [change(`${ROOT}/readme.md`)]);
    const { spoken, approval, respond, say, voiceSays } = setup({ files });
    approval.request(FILES, { threadId: THREAD, itemId: "call-1" }, respond);
    expect(files).toHaveBeenCalledWith({ threadId: THREAD, itemId: "call-1" });
    expect(spoken).toEqual(["I need your OK to change this file: readme.md. Should I go ahead? Say yes or no."]);
    voiceSays();
    say("yes");
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "accept" });
  });

  it("declines more than three files with the files notice", () => {
    const { spoken, outcomes, approval, respond } = setup();
    approval.request("applyPatchApproval", { conversationId: THREAD, fileChanges: { a: {}, b: {}, c: {}, d: {} } }, respond);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "denied" });
    expect(outcomes).toEqual(["decline"]);
    expect(spoken).toEqual([NOTICE_FILES]);
  });

  it("declines a file change whose files are unknown", () => {
    const a = setup();
    a.approval.request(FILES, { threadId: THREAD }, a.respond);
    expect(a.respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(a.spoken).toEqual([NOTICE_FILES]);
    const b = setup({ files: () => null });
    b.approval.request(FILES, { threadId: THREAD, itemId: "call-1" }, b.respond);
    expect(b.respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    const c = setup({ files: () => [] });
    c.approval.request(FILES, { threadId: THREAD, itemId: "call-1" }, c.respond);
    expect(c.respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
  });
});

describe("live Codex approval counts only a voice output that names the request", () => {
  /** The voice says the text, then enough time passes for the longest question and its echo. */
  const voiceSaysOwnWords = (approval: ReturnType<typeof setup>["approval"], text: string) => {
    approval.voiceSpeech();
    approval.voiceDone(text);
    vi.advanceTimersByTime(10_000);
  };

  it("does not take a yes after an unrelated output and declines at the timeout", () => {
    const { approval, outcomes, respond, open, say } = setup();
    open("rm -rf build");
    voiceSaysOwnWords(approval, "Sure, doing it now.");
    say("yes");
    expect(respond).not.toHaveBeenCalled();
    expect(outcomes).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(outcomes).toEqual(["timeout"]);
  });

  it("takes a yes after an output that names the command in its own words", () => {
    const { approval, outcomes, respond, open, say } = setup();
    open("rm -rf build");
    voiceSaysOwnWords(approval, "Okay, to go on I want to run rm -rf build. Is that fine? Please say yes or no.");
    say("yes");
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "accept" });
    expect(outcomes).toEqual(["accept"]);
  });

  it.each([
    ["drops the program word", "git push origin main", "Shall I push origin main? Say yes or no."],
    ["names too few of its words", "git reset --hard origin main", "Can I run git now? Say yes or no."],
  ])("does not take a yes after an output that %s", (_name, command, output) => {
    const { approval, respond, open, say } = setup();
    open(command);
    voiceSaysOwnWords(approval, output);
    say("yes");
    expect(respond).not.toHaveBeenCalled();
  });

  it("takes a yes after a later output that names the command", () => {
    const { approval, spoken, respond, open, say } = setup();
    open("rm -rf build");
    voiceSaysOwnWords(approval, "Sure, doing it now.");
    say("yes");
    expect(respond).not.toHaveBeenCalled();
    voiceSaysOwnWords(approval, spoken[0]!);
    say("yes");
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "accept" });
  });

  it("does not take a yes after an output that leaves out a file name", () => {
    const { approval, spoken, respond, say } = setup({ files: () => [change("src/app.ts"), change("src/util.ts")] });
    approval.request(FILES, { threadId: THREAD, itemId: "call-1" }, respond);
    expect(spoken).toEqual(["I need your OK for these file changes: change src/app.ts, change src/util.ts. Should I go ahead? Say yes or no."]);
    voiceSaysOwnWords(approval, "I want to change src/app.ts. Is that okay? Say yes or no.");
    say("yes");
    expect(respond).not.toHaveBeenCalled();
    voiceSaysOwnWords(approval, "I want to change app.ts and util.ts in src. Is that okay? Say yes or no.");
    say("yes");
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "accept" });
  });
});

describe("live Codex approval speaks only file paths inside the working folder", () => {
  const expectDeclined = ({ spoken, outcomes, respond }: ReturnType<typeof setup>) => {
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(outcomes).toEqual(["decline"]);
    expect(spoken).toEqual([NOTICE_FILES]);
  };

  it.each([
    ["a relative path", "src/app.ts"],
    ["an absolute path inside the folder", `${ROOT}/src/app.ts`],
    ["a path with a dot step", "./src/app.ts"],
  ])("speaks %s relative to the working folder", (_name, path) => {
    const { spoken, respond } = askFiles([change(path, "add")]);
    expect(respond).not.toHaveBeenCalled();
    expect(spoken).toEqual(["I need your OK to create this file: src/app.ts. Should I go ahead? Say yes or no."]);
  });

  it.each([
    ["an absolute path outside the folder", "/etc/hosts"],
    ["a sibling folder with the same prefix", `${ROOT}-other/a.ts`],
    ["the folder itself", ROOT],
    ["a parent step out of the folder", "src/../../etc/hosts"],
    ["a parent step that stays inside", "src/../app.ts"],
    ["a backslash parent step", "src\\..\\..\\a.ts"],
    ["a home path", "~/.bashrc"],
    ["the repository folder", ".git/hooks/pre-commit"],
    ["a repository folder in capitals deeper down", "deploy/.GIT/config"],
    ["the forge workflows", ".github/workflows/ci.yml"],
    ["the key folder", ".ssh/config"],
    ["the agent settings", ".codex/config.toml"],
    ["an env file", ".env.local"],
    ["a name over 80 characters", `${"x".repeat(78)}.ts`],
    ["a letter outside plain ASCII", "src/naïve.ts"],
    ["a shell character", "src/a$b.ts"],
  ])("declines at once %s", (_name, path) => {
    expectDeclined(askFiles([change(path)]));
  });

  it("asks about a name of exactly 80 characters", () => {
    const path = `${"x".repeat(77)}.ts`;
    const { spoken, respond } = askFiles([change(path)]);
    expect(respond).not.toHaveBeenCalled();
    expect(spoken).toEqual([`I need your OK to change this file: ${path}. Should I go ahead? Say yes or no.`]);
  });

  it.each([
    ["add", "create"],
    ["delete", "delete"],
    ["update", "change"],
    [null, "change"],
  ] as const)("speaks the %s kind as %j", (kind, verb) => {
    const { spoken } = askFiles([change("old.ts", kind)]);
    expect(spoken).toEqual([`I need your OK to ${verb} this file: old.ts. Should I go ahead? Say yes or no.`]);
  });

  it("speaks a move with its target and accepts a yes", () => {
    const { spoken, respond, say, voiceSays } = askFiles([change(`${ROOT}/a.ts`, "update", `${ROOT}/lib/a.ts`)]);
    expect(spoken).toEqual(["I need your OK to move this file: a.ts to lib/a.ts. Should I go ahead? Say yes or no."]);
    voiceSays();
    say("yes");
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "accept" });
  });

  it.each([
    ["a move out of the folder", change("a.ts", "update", `${OUTSIDE}/a.ts`)],
    ["a move up a parent step", change("a.ts", "update", "../a.ts")],
    ["a move into the repository folder", change("hook.sh", "update", ".git/hooks/pre-commit")],
    ["a delete outside the folder", change("/etc/passwd", "delete")],
  ])("declines at once %s", (_name, item) => {
    expectDeclined(askFiles([item]));
  });

  it("declines the whole list when one path of it is outside the folder", () => {
    expectDeclined(askFiles([change("a.ts"), change("/etc/hosts")]));
  });

  it("declines each file change when the call has no working folder", () => {
    expectDeclined(askFiles([change("a.ts")], { cwd: undefined }));
  });

  it("speaks the kinds of a legacy patch", () => {
    const { approval, spoken, respond } = setup();
    approval.request("applyPatchApproval", {
      conversationId: THREAD,
      fileChanges: {
        [`${ROOT}/new.ts`]: { type: "add", content: "" },
        [`${ROOT}/old.ts`]: { type: "delete", content: "" },
        [`${ROOT}/src/x.ts`]: { type: "update", unified_diff: "", move_path: `${ROOT}/lib/x.ts` },
      },
    }, respond);
    expect(respond).not.toHaveBeenCalled();
    expect(spoken).toEqual(["I need your OK for these file changes: create new.ts, delete old.ts, move src/x.ts to lib/x.ts. Should I go ahead? Say yes or no."]);
  });

  it.each([
    ["a path outside the folder", { "/etc/hosts": { type: "delete", content: "" } }],
    ["a move target that is not text", { "a.ts": { type: "update", unified_diff: "", move_path: 5 } }],
  ])("declines a legacy patch with %s", (_name, fileChanges) => {
    const { approval, spoken, respond } = setup();
    approval.request("applyPatchApproval", { conversationId: THREAD, fileChanges }, respond);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "denied" });
    expect(spoken).toEqual([NOTICE_FILES]);
  });
});

describe("live Codex approval follows symlinks to the real file", () => {
  beforeAll(() => {
    mkdirSync(join(ROOT, "lib"), { recursive: true });
    writeFileSync(join(ROOT, "lib", "old.ts"), "");
    mkdirSync(join(ROOT, ".git", "hooks"), { recursive: true });
    writeFileSync(join(OUTSIDE, "authorized_keys"), "");
    symlinkSync(OUTSIDE, join(ROOT, "link"));
    symlinkSync(join(ROOT, ".git"), join(ROOT, "repo-data"));
    symlinkSync(join(ROOT, "gone"), join(ROOT, "dangling"));
    symlinkSync(join(OUTSIDE, "authorized_keys"), join(ROOT, "keys.txt"));
    symlinkSync(join(ROOT, "lib", "old.ts"), join(ROOT, "alias.ts"));
    symlinkSync(ROOT, join(OUTSIDE, "project"));
  });


  it.each([
    ["an existing file under a folder symlink that points outside", change("link/authorized_keys")],
    ["a new file under a folder symlink that points outside", change("link/new.ts", "add")],
    ["a folder symlink to the repository folder", change("repo-data/hooks/pre-commit", "add")],
    ["a folder symlink that points nowhere", change("dangling/a.ts", "add")],
    ["a file symlink that points outside", change("keys.txt")],
    ["a file symlink that points inside", change("alias.ts")],
    ["a path under a file", change("lib/old.ts/a.ts", "add")],
    ["a move through a folder symlink that points outside", change("lib/old.ts", "update", "link/old.ts")],
  ])("declines at once %s", (_name, item) => {
    const { spoken, outcomes, respond } = askFiles([item]);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(outcomes).toEqual(["decline"]);
    expect(spoken).toEqual([NOTICE_FILES]);
  });

  it("asks about a new file in an existing subfolder", () => {
    const { spoken, respond } = askFiles([change("lib/new.ts", "add")]);
    expect(respond).not.toHaveBeenCalled();
    expect(spoken).toEqual(["I need your OK to create this file: lib/new.ts. Should I go ahead? Say yes or no."]);
  });

  it("asks about an existing file", () => {
    const { spoken, respond } = askFiles([change(join(ROOT, "lib", "old.ts"), "delete")]);
    expect(respond).not.toHaveBeenCalled();
    expect(spoken).toEqual(["I need your OK to delete this file: lib/old.ts. Should I go ahead? Say yes or no."]);
  });

  it.each([
    ["the symlinked path", join(OUTSIDE, "project", "lib", "new.ts")],
    ["the real path", join(ROOT, "lib", "new.ts")],
  ])("speaks %s of a working folder reached through a symlink relative to it", (_name, path) => {
    const { spoken, respond } = askFiles([change(path, "add")], { cwd: join(OUTSIDE, "project") });
    expect(respond).not.toHaveBeenCalled();
    expect(spoken).toEqual(["I need your OK to create this file: lib/new.ts. Should I go ahead? Say yes or no."]);
  });

  it("declines each file change when the working folder does not exist", () => {
    const { spoken, respond } = askFiles([change("a.ts", "add")], { cwd: join(ROOT, "missing") });
    expect(respond).toHaveBeenCalledExactlyOnceWith({ decision: "decline" });
    expect(spoken).toEqual([NOTICE_FILES]);
  });
});

describe("live Codex approval copy", () => {
  it("speaks as the bot in the first person, in short sentences, and never names the backend", () => {
    const spoken: string[] = [];
    const collect = (method: string, params: Record<string, unknown>, files?: LiveCodexFileChange[]) => {
      const { approval, spoken: said } = setup({ files: () => files ?? null });
      approval.request(method, { threadId: THREAD, ...params }, vi.fn());
      spoken.push(...said);
    };
    collect(COMMAND, { command: "ls -la" });
    collect(COMMAND, { command: "ls; pwd" });
    collect(COMMAND, { command: "curl example.com", networkApprovalContext: { host: "example.com" } });
    collect(FILES, {}, [change("a.ts")]);
    collect(FILES, {}, [change("a.ts", "add"), change("b.ts", "delete")]);
    collect(FILES, {}, [change("src/a.ts", "update", "lib/a.ts")]);
    collect(FILES, {}, [change("src/a.ts", "update", "lib/a.ts"), change("docs/b.md", "add"), change("c.ts", "delete")]);
    collect(FILES, {});
    collect(PERMISSIONS, { permissions: {} });
    expect(spoken).toHaveLength(9);
    for (const text of spoken) {
      expect(text).not.toMatch(/codex/i);
      expect(text).toMatch(/^I /);
      for (const sentence of text.split(/(?<=[.?!])\s+/)) expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(20);
    }
  });
});
