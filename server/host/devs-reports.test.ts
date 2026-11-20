import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { citationAttachment, createCitationTextSelector } from "../../src/lib/citations.ts";
import { composeMessage, pasteAttachment } from "../../src/lib/composer-attachments.ts";
import "../server-line-packs.ts";
import type { DevsReportPayload } from "../devs-report.ts";
import { devsReportSender, type ReportStatusAnswer, ReportStatusQuestion, SendOutcome } from "../devs-report-send.ts";
import type { Message, StoreChange } from "../store.ts";
import { draftLine, laterLine, refusedLine } from "./devs-report-words.ts";
import { createDevsReports, DEVS_REPORTS_FILE, fixedLine, LONGEST_WAIT_MS, NO_ANSWER_MS, RETRY_MS, STATUS_EVERY_MS, STATUS_FIRST_MS, TRACKED_MS,
  type DevsReportsDeps } from "./devs-reports.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const SCOUT = { id: "scout", name: "Scout", threadId: "scout-main", modelSelection: { instanceId: "claude", model: "claude-opus-5-5" }, composio: true };
const ROVER = { id: "rover", name: "Rover", threadId: "rover-main", modelSelection: { instanceId: "codex", model: "gpt-5.5", effort: "high" } };
/** The English line a bot tells the person after report_bug. */
const READY = "Your bug report is ready. Review it under your message and select Send report. Nothing is sent before that.";
const readyAnswer = (line: string) => `Ready for the person to review. Tell them this line in your reply, word for word: "${line}"`;
/** Longer than a draft or a saved report is kept. */
const TOO_OLD_MS = 8 * 24 * 3_600_000;

function fixture(options: { dataDir?: string; sections?: string[]; outcomes?: SendOutcome[]; automated?: boolean; lineLanguage?: DevsReportsDeps["lineLanguage"];
  reactorOf?: DevsReportsDeps["reactorOf"]; direct?: boolean; appVersion?: string; clock?: number;
  /** The conversations, kept across a restart (another fixture on the same data). */
  threads?: Map<string, Message[]>;
  /** The MausBot team's answer to each question about this app's reports; none: no answer (offline). */
  answer?: (question: ReportStatusQuestion) => ReportStatusAnswer | null;
  /** Replaces the sender that answers from `outcomes`. */
  send?: DevsReportsDeps["send"] } = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "omb-devs-reports-"));
  if (!options.dataDir) dirs.push(dataDir);
  const listeners = new Set<(change: StoreChange) => void>();
  const threads = options.threads ?? new Map<string, Message[]>();
  let ids = [...threads.values()].reduce((sum, lines) => sum + lines.length, 0), clock = options.clock ?? Date.UTC(2026, 9, 27, 9, 0);
  const busy = new Set<string>();
  const bots = [SCOUT, ROVER];
  const groups = [{ id: "launch", name: "Launch", threadId: "room", memberIds: ["scout", "rover"] }];
  const store = {
    bots,
    sections: options.sections ?? [],
    bot: (id: string) => bots.find((bot) => bot.id === id) ?? null,
    botByThread: (threadId: string) => bots.find((bot) => bot.threadId === threadId) ?? null,
    groupByThread: (threadId: string) => groups.find((group) => group.threadId === threadId),
    projectBotForTask: () => null,
    activePath: (threadId: string) => threads.get(threadId) ?? [],
    appendMessage: (threadId: string, message: Omit<Message, "id" | "at"> & { at?: number }) => {
      const full = { id: `${threadId}:m${++ids}`, at: clock, ...message } as Message;
      threads.set(threadId, [...(threads.get(threadId) ?? []), full]);
      for (const listener of listeners) listener({ type: "message", threadId, message: full });
      return full;
    },
    patchMessage: (threadId: string, messageId: string, patch: Partial<Message>) => {
      const lines = threads.get(threadId);
      if (!lines) throw new Error("no such conversation");
      const index = lines.findIndex((line) => line.id === messageId);
      if (index < 0) return null;
      lines[index] = { ...lines[index]!, ...patch };
      return lines[index]!;
    },
    onChange: (listener: (change: StoreChange) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const sent: DevsReportPayload[] = [];
  const outcomes = [...(options.outcomes ?? [])];
  const asked: ReportStatusQuestion[] = [], told: Array<{ threadId: string; text: string; person?: string }> = [];
  const deps: DevsReportsDeps = {
    dataDir, store: store as never, installId: "4b7c1f2e-0a9d-4c2b-9f1e-6d5a4b3c2d1e", appVersion: options.appVersion ?? "0.1.128", runsOn: "desktop app",
    working: (threadId) => busy.has(threadId), automated: () => options.automated === true,
    engine: (instanceId) => ({ name: instanceId === "claude" ? "Claude Code" : "Codex", snapshot: { state: "available", authenticated: true } }),
    appsReady: () => false, language: () => "en", ...(options.lineLanguage ? { lineLanguage: options.lineLanguage } : {}),
    ...(options.reactorOf ? { reactorOf: options.reactorOf } : {}), ...(options.direct === undefined ? {} : { direct: options.direct }),
    recentLog: () => ["2026-10-27T08:59:00.000Z warn engine probe slow"],
    send: options.send ?? (async (payload) => { sent.push(payload); return outcomes.shift() ?? { ok: true, id: `report-${sent.length}` }; }),
    askStatus: async (question) => { asked.push(question); return options.answer?.(question) ?? null; },
    tell: (threadId, text, person) => { told.push({ threadId, text, ...(person ? { person } : {}) }); },
    now: () => clock, timer: false,
  };
  const reports = createDevsReports(deps);
  const person = (threadId: string, text: string, extra: Partial<Message> = {}) =>
    store.appendMessage(threadId, { role: "user", kind: "text", text, sendId: `send-${ids}`, ...extra });
  const bot = (threadId: string, text: string, extra: Partial<Message> = {}) => store.appendMessage(threadId, { role: "bot", kind: "text", text, ...extra });
  const call = async (botId: string, threadId: string, body: unknown) => {
    let answer: { status: number; body: Record<string, unknown> } | undefined;
    await reports.internal({ method: "POST", path: "/api/internal/devs/report", botId, threadId, readBody: async () => body, res: {} as never,
      json: ((_res: unknown, status: number, value: Record<string, unknown>) => { answer = { status, body: value }; }) as never });
    return answer!;
  };
  const settle = async () => { reports.tick(); await reports.idle(); };
  /** The system lines in a conversation. A draft never adds one. */
  const notices = (threadId: string) => store.activePath(threadId).filter((line) => line.kind === "activity").map((line) => line.tool!.name).filter((name) => name.startsWith("notice:"));
  const line = (threadId: string, messageId: string) => store.activePath(threadId).find((one) => one.id === messageId);
  /** What the person sees under their message: the draft's line. */
  const offer = (threadId: string, messageId: string) => line(threadId, messageId)?.bugOffer;
  const offers = (threadId: string) => store.activePath(threadId).filter((one) => one.bugOffer !== undefined);
  /** The draft under a message, as the person it is for reads it. */
  const view = (threadId: string, messageId: string, who = "user") => {
    const shown = offer(threadId, messageId);
    return shown ? reports.viewDraft(shown.id, who) : null;
  };
  /** "Send report", pressed by `who` on the draft under a message. */
  const press = (threadId: string, messageId: string, who = "user") => {
    const shown = offer(threadId, messageId);
    if (!shown) throw new Error("no draft under that message");
    return reports.sendDraft(shown.id, who);
  };
  /** The conversation is deleted, as the store says it. */
  const drop = (threadId: string) => { threads.delete(threadId); for (const listener of listeners) listener({ type: "thread.deleted", threadId } as StoreChange); };
  return { reports, store, sent, busy, person, bot, call, settle, notices, dataDir, asked, told, line, offer, offers, view, press, drop, threads, now: () => clock,
    advance: (ms: number) => { clock += ms; }, stop: () => reports.stop() };
}
const keptFile = (fx: { dataDir: string }) => JSON.parse(readFileSync(join(fx.dataDir, DEVS_REPORTS_FILE), "utf8"));

describe("a message that tags @devs", () => {
  it("makes one draft with the bot's summary when the bot calls report_bug, and sends nothing before the person sends it", async () => {
    const fx = fixture();
    const message = fx.person("scout-main", "@devs pictures never load, key sk-ant-" + "a".repeat(40));
    const kept = readFileSync(join(fx.dataDir, DEVS_REPORTS_FILE), "utf8");
    expect(kept).toContain("pictures never load");
    expect(kept).not.toContain("sk-ant-a");
    fx.busy.add("scout-main");
    const note = fx.reports.note("scout-main", true);
    expect(note).toContain("tags @devs");
    expect(note).toContain("report_bug");
    expect(note).toContain("nothing goes until the person reads it and sends it");
    fx.store.appendMessage("scout-main", { role: "bot", kind: "activity", tool: { name: "Bash", ok: false, output: "exit code 127: convert: not found" } });
    const answer = await fx.call("scout", "scout-main", { went_wrong: "Pictures never load", you_saw: "Bash failed with exit code 127", steps: "1. Attach a picture" });
    expect(answer.status).toBe(200);
    expect(answer.body.text).toBe(readyAnswer(READY));
    expect(fx.sent).toEqual([]);
    expect(fx.offer("scout-main", message.id)).toEqual({ id: expect.any(String), for: "user", from: "devs", by: "Scout", state: "offer" });
    expect(readFileSync(join(fx.dataDir, DEVS_REPORTS_FILE), "utf8")).not.toContain("sk-ant-a");
    const draft = fx.view("scout-main", message.id)!;
    expect(draft).toMatchObject({ from: "devs", by: "Scout", state: "offer", direct: true });
    expect(draft.title).not.toBe("");
    expect(draft.description).toContain("Scout's summary: Pictures never load");

    fx.bot("scout-main", `Thanks. ${READY}`, { turnId: "t1", turnSucceeded: true });
    fx.busy.delete("scout-main");
    await fx.settle();
    fx.advance(LONGEST_WAIT_MS * 2);
    await fx.settle();
    expect(fx.sent).toEqual([]);
    expect(fx.offers("scout-main")).toHaveLength(1);

    expect(await fx.press("scout-main", message.id)).toMatchObject({ id: draft.id, state: "sent" });
    expect(fx.sent).toHaveLength(1);
    const [payload] = fx.sent;
    expect(payload!.description.split("\n")[0]).toBe(`pictures never load, key «redacted ${"sk-ant-".length + 40} chars»`);
    expect(payload!.description).toContain("Scout's summary: Pictures never load");
    expect(payload!.diagnostics).toContain(`Message: ${message.id}`);
    expect(payload!.diagnostics).toContain("tool Bash failed: exit code 127: convert: not found");
    expect(payload!.diagnostics).toContain("Engine: Claude Code (claude), model claude-opus-5-5");
    expect(payload!.diagnostics).toContain("warn engine probe slow");
    expect(JSON.stringify(payload)).not.toContain("sk-ant-a");
    expect(fx.offer("scout-main", message.id)).toMatchObject({ id: draft.id, state: "sent" });
    expect(fx.line("scout-main", message.id)!.bugReport).toEqual({ id: "report-1", status: "received" });
    expect(fx.notices("scout-main")).toEqual([]);
    expect(fx.reports.note("scout-main", true)).toBe("");
    expect((await fx.call("scout", "scout-main", { went_wrong: "again" })).body.text).toMatch(/^Already prepared: report_bug writes one draft per @devs message/);
    expect(fx.sent).toHaveLength(1);
    fx.stop();
  });

  it("makes the draft from the server's facts when the bot never calls report_bug, adds no system line, and sends nothing", async () => {
    const fx = fixture();
    const message = fx.person("scout-main", "@devs the send button froze");
    fx.busy.add("scout-main");
    fx.reports.note("scout-main", true);
    await fx.settle();
    expect(fx.offer("scout-main", message.id)).toBeUndefined();
    fx.bot("scout-main", "Sorry about that.", { turnId: "t1", turnSucceeded: true });
    fx.busy.delete("scout-main");
    await fx.settle();
    await fx.settle();
    expect(fx.offers("scout-main")).toHaveLength(1);
    expect(fx.offer("scout-main", message.id)).toEqual({ id: expect.any(String), for: "user", from: "devs", state: "offer" });
    expect(fx.view("scout-main", message.id)!.description).toContain("No summary from a bot: the bot did not call report_bug.");
    expect(fx.sent).toEqual([]);
    expect(fx.notices("scout-main")).toEqual([]);
    expect(fx.store.activePath("scout-main").at(-1)?.kind).toBe("text");

    expect(await fx.press("scout-main", message.id)).toMatchObject({ state: "sent" });
    expect(fx.sent).toHaveLength(1);
    expect(fx.sent[0]!.description).toContain("No summary from a bot: the bot did not call report_bug.");
    expect(fx.notices("scout-main")).toEqual([]);
    fx.advance(LONGEST_WAIT_MS * 2);
    await fx.settle();
    expect(fx.offers("scout-main")).toHaveLength(1);
    expect(fx.sent).toHaveLength(1);
    fx.stop();
  });

  it("names why there is no summary: no answer, no tools, a failed turn, a turn that never ends", async () => {
    const fx = fixture();
    const nobody = fx.person("scout-main", "@devs nobody answers");
    await fx.settle();
    expect(fx.offer("scout-main", nobody.id)).toBeUndefined();
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(fx.view("scout-main", nobody.id)!.description).toContain("no bot answered the message");

    const codex = fx.person("rover-main", "@devs Codex is odd");
    fx.busy.add("rover-main");
    expect(fx.reports.note("rover-main", false)).toBe("");
    fx.busy.delete("rover-main");
    await fx.settle();
    expect(fx.view("rover-main", codex.id)!.description).toContain("the bot's engine cannot use Seira's tools");
    expect(fx.view("rover-main", codex.id)!.diagnostics).toContain("Engine: Codex (codex), model gpt-5.5, effort high");

    const failed = fx.person("scout-main", "@devs it failed");
    fx.busy.add("scout-main");
    fx.reports.note("scout-main", true);
    fx.store.appendMessage("scout-main", { role: "bot", kind: "activity", tool: { name: "error: Claude Code is not signed in", ok: false, setup: true } });
    fx.busy.delete("scout-main");
    await fx.settle();
    expect(fx.view("scout-main", failed.id)!.description).toContain("the bot's turn failed");
    expect(fx.view("scout-main", failed.id)!.diagnostics).toContain("turn failed: Claude Code is not signed in (needs setup)");

    const stuck = fx.person("scout-main", "@devs stuck forever");
    fx.busy.add("scout-main");
    await fx.settle();
    expect(fx.offer("scout-main", stuck.id)).toBeUndefined();
    fx.advance(LONGEST_WAIT_MS);
    await fx.settle();
    expect(fx.view("scout-main", stuck.id)!.description).toContain("its turn was still running after 10 minutes");
    expect(fx.sent).toEqual([]);
    expect(fx.notices("scout-main")).toEqual([]);
    fx.stop();
  });

  it("makes no draft for code, an old line, a bot's line, a teammate bot's ask or a routine's prompt", async () => {
    const fx = fixture({ automated: true });
    fx.person("scout-main", "look: `@devs` and\n```\n@devs\n```");
    fx.person("scout-main", "@devs from history", { at: Date.UTC(2026, 9, 26) });
    fx.bot("scout-main", "@devs is how you report a bug");
    fx.person("scout-main", "@devs from a teammate", { peerAsk: { botId: "rover", name: "Rover" } });
    fx.person("scout-main", "@devs routine prompt", { sendId: undefined });
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(fx.sent).toEqual([]);
    expect(fx.offers("scout-main")).toEqual([]);
    expect((await fx.call("scout", "scout-main", { went_wrong: "x" })).status).toBe(409);
    const real = fx.person("scout-main", "@devs a person during a routine");
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(fx.offers("scout-main").map((one) => one.id)).toEqual([real.id]);
    expect(fx.sent).toEqual([]);
    fx.stop();
  });

  it("puts a quote in the draft as the person read it: their own words first, the quote as written and redacted, never its encoded copy", async () => {
    const fx = fixture();
    const token = `ghp_${"t".repeat(36)}`;
    const said = fx.bot("scout-main", "The relay failed.\nI only send a report when your message tags @devs.");
    const quote = citationAttachment({ ownerType: "bot", ownerId: "scout", threadId: "scout-main", messageId: said.id },
      createCitationTextSelector(said.text!, 0, said.text!.length)!, `@devs help me send on it, my token is ${token}`);
    const message = fx.person("scout-main", composeMessage("", [quote]));
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(fx.sent).toEqual([]);
    expect(JSON.stringify(fx.view("scout-main", message.id))).not.toContain(token);
    await fx.press("scout-main", message.id);
    expect(fx.sent).toHaveLength(1);
    const { description } = fx.sent[0]!;
    const [words, rest] = description.split("\n\nWhat they wrote: ");
    expect(words).toBe(`help me send on it, my token is «redacted ${token.length} chars»`);
    expect(rest).toMatch(/^> Quoted message:\n> The relay failed\.\n> I only send a report when your message tags @devs\.\n/);
    expect(JSON.stringify(fx.sent[0])).not.toContain("omb-citation");
    expect(JSON.stringify(fx.sent[0])).not.toContain(token);
    expect(readFileSync(join(fx.dataDir, DEVS_REPORTS_FILE), "utf8")).not.toContain("omb-citation");
    fx.stop();
  });

  it("makes no draft for a @devs that is only inside a quote; the person's own @devs beside the same quote makes one", async () => {
    const fx = fixture();
    const said = fx.bot("scout-main", "I only send a report when your message tags @devs.");
    const quote = (comment: string) => citationAttachment({ ownerType: "bot", ownerId: "scout", threadId: "scout-main", messageId: said.id },
      createCitationTextSelector(said.text!, 0, said.text!.length)!, comment);
    fx.person("scout-main", composeMessage("what does this mean?", [quote("really?")]));
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(fx.offers("scout-main")).toEqual([]);
    const own = fx.person("scout-main", composeMessage("@devs this is wrong", [quote("")]));
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(fx.offers("scout-main").map((one) => one.id)).toEqual([own.id]);
    expect(fx.sent).toEqual([]);
    await fx.press("scout-main", own.id);
    expect(fx.sent).toHaveLength(1);
    expect(fx.sent[0]!.description.split("\n")[0]).toBe("this is wrong");
    fx.stop();
  });

  it("makes no draft for a @devs that is only inside pasted text; the person's own @devs beside the paste makes one", async () => {
    const fx = fixture();
    const notes = pasteAttachment("What's new\n- Quoted @devs reports send correctly.\n* fix(devs-reports): a quoted @devs alone sends nothing");
    fx.person("scout-main", composeMessage("does this update change how we work?", [notes]));
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(fx.offers("scout-main")).toEqual([]);
    const own = fx.person("scout-main", composeMessage("@devs it crashes with this log", [notes]));
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(fx.offers("scout-main").map((one) => one.id)).toEqual([own.id]);
    await fx.press("scout-main", own.id);
    expect(fx.sent).toHaveLength(1);
    const [words, written] = fx.sent[0]!.description.split("\n\nWhat they wrote: ");
    expect(words).toContain("<pasted-text index=\"1\">\nWhat's new");
    expect(written).toContain("Quoted @devs reports send correctly.");
    fx.stop();
  });

  it("makes no draft for a @devs in a quote comment that is itself inside pasted text", async () => {
    const fx = fixture();
    const said = fx.bot("scout-main", "I only send a report when your message tags @devs.");
    const quoted = composeMessage("", [citationAttachment({ ownerType: "bot", ownerId: "scout", threadId: "scout-main", messageId: said.id },
      createCitationTextSelector(said.text!, 0, said.text!.length)!, "@devs this is wrong")]);
    fx.person("scout-main", composeMessage("what did I send yesterday?", [pasteAttachment(quoted)]));
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(fx.offers("scout-main")).toEqual([]);
    expect(fx.sent).toEqual([]);
    fx.stop();
  });

  it("keeps an opening paste line with no closing line as the person's text, and reads many of them quickly", async () => {
    const fx = fixture();
    const started = performance.now();
    const message = fx.person("scout-main", `<pasted-text>\n@devs it broke\n${"<pasted-text>\n".repeat(50_000)}`);
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(fx.offer("scout-main", message.id)).toMatchObject({ state: "offer" });
    fx.stop();
  });

  it("still reads a typed @devs before an opening paste line followed by a very long unclosed tail", async () => {
    const fx = fixture();
    const message = fx.person("scout-main", `@devs it broke\n<pasted-text>\n${"\n".repeat(150_000)}x`);
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(fx.offer("scout-main", message.id)).toMatchObject({ state: "offer" });
    fx.stop();
  });

  it("reads each part on its own: a code span the quote cuts in half does not hide the person's own @devs", async () => {
    const fx = fixture();
    const said = fx.bot("scout-main", "Try: run `npm i` first.");
    const quote = citationAttachment({ ownerType: "bot", ownerId: "scout", threadId: "scout-main", messageId: said.id },
      createCitationTextSelector(said.text!, 0, 12)!, "@devs it fails at `install`");
    const message = fx.person("scout-main", composeMessage("", [quote]));
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(fx.offer("scout-main", message.id)).toMatchObject({ state: "offer" });
    fx.stop();
  });

  it("drops a marker it cannot read too, so nothing encoded slips past redaction", async () => {
    const fx = fixture();
    const token = `ghp_${"t".repeat(36)}`;
    const message = fx.person("scout-main", `<!--omb-citation-v1:${Buffer.from(JSON.stringify({ comment: token })).toString("base64url")}-->\n@devs it broke`);
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(JSON.stringify(fx.view("scout-main", message.id))).not.toContain("omb-citation");
    await fx.press("scout-main", message.id);
    expect(fx.sent).toHaveLength(1);
    expect(fx.sent[0]!.description.split("\n")[0]).toBe("it broke");
    expect(JSON.stringify(fx.sent[0])).not.toContain("omb-citation");
    expect(readFileSync(join(fx.dataDir, DEVS_REPORTS_FILE), "utf8")).not.toContain("omb-citation");
    fx.stop();
  });

  it("makes no draft for a message that tags a department named devs", async () => {
    const fx = fixture({ sections: ["Devs"] });
    fx.person("scout-main", "I added Rover to the @devs department, notify Scout");
    fx.busy.add("scout-main");
    expect(fx.reports.note("scout-main", true)).toBe("");
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(fx.sent).toEqual([]);
    expect(fx.offers("scout-main")).toEqual([]);
    expect((await fx.call("scout", "scout-main", { went_wrong: "x" })).status).toBe(409);
    fx.stop();
  });
});

describe("what a draft carries", () => {
  it("has no contact address and no install line, and cleans paths and emails in its diagnostics", async () => {
    const fx = fixture();
    const message = fx.person("scout-main", "@devs it broke");
    fx.store.appendMessage("scout-main", { role: "bot", kind: "activity", tool: { name: "Bash", ok: false, output: "cannot open /home/ada/work/app.ts for ada@example.com" } });
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    const draft = fx.view("scout-main", message.id)!;
    expect(draft.diagnostics).toContain("tool Bash failed");
    await fx.press("scout-main", message.id);
    const [payload] = fx.sent;
    expect(payload).not.toHaveProperty("contactEmail");
    expect(payload).not.toHaveProperty("contact");
    expect(payload!.installId).toBe("4b7c1f2e-0a9d-4c2b-9f1e-6d5a4b3c2d1e");
    for (const diagnostics of [draft.diagnostics, payload!.diagnostics]) {
      expect(diagnostics).not.toMatch(/^\s*Install:/m);
      expect(diagnostics).not.toContain("ada@example.com");
      expect(diagnostics).not.toContain("/home/ada");
    }
    fx.stop();
  });
});

describe("what the person is told, in their language", () => {
  const german = (person?: string) => (person === "p-ada" ? "de" : undefined);
  const ada = { sender: { name: "Ada", id: "p-ada" } };

  it("gives the bot the draft line in Portuguese, and adds no system line", async () => {
    const fx = fixture({ lineLanguage: () => "pt-br" });
    fx.person("scout-main", "@devs o botão travou");
    fx.busy.add("scout-main");
    fx.reports.note("scout-main", true);
    const answer = await fx.call("scout", "scout-main", { went_wrong: "o botão travou" });
    expect(draftLine("pt-br")).not.toBe(READY);
    expect(answer.body.text).toBe(readyAnswer(draftLine("pt-br")));
    expect(fx.notices("scout-main")).toEqual([]);
    expect(fx.store.activePath("scout-main").at(-1)?.tool?.nameCode).toBeUndefined();
    fx.stop();
  });

  it("gives the bot the line in the language of the person who wrote @devs, whoever the bot talks to", async () => {
    const fx = fixture({ lineLanguage: german });
    fx.person("scout-main", "@devs die Bilder laden nicht", ada);
    fx.person("rover-main", "@devs the pictures do not load", { sender: { name: "Bob", id: "p-bob" } });
    for (const threadId of ["scout-main", "rover-main"]) { fx.busy.add(threadId); fx.reports.note(threadId, true); }
    expect(draftLine("de")).not.toBe(READY);
    expect((await fx.call("scout", "scout-main", { went_wrong: "Bilder laden nicht" })).body.text).toBe(readyAnswer(draftLine("de")));
    expect((await fx.call("rover", "rover-main", { went_wrong: "pictures do not load" })).body.text).toBe(readyAnswer(READY));
    fx.stop();
  });
});

describe("sending a draft", () => {
  it("sends once for the person it is for, and a second press or a press at the same time sends nothing more", async () => {
    const fx = fixture();
    const message = fx.person("scout-main", "@devs the room is stuck");
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    const first = fx.press("scout-main", message.id), second = fx.press("scout-main", message.id);
    expect(await first).toMatchObject({ state: "sent" });
    expect(await second).toMatchObject({ state: "sent" });
    expect(await fx.press("scout-main", message.id)).toMatchObject({ state: "sent" });
    expect(fx.sent).toHaveLength(1);
    fx.stop();
  });

  it("follows a report only after it went: nothing is tracked or shown while the draft waits", async () => {
    const fx = fixture();
    const message = fx.person("scout-main", "@devs the calendar never syncs");
    fx.advance(NO_ANSWER_MS + STATUS_FIRST_MS);
    await fx.settle();
    expect(fx.line("scout-main", message.id)!.bugReport).toBeUndefined();
    expect(keptFile(fx).tracked).toEqual([]);
    expect(fx.asked).toEqual([]);
    await fx.press("scout-main", message.id);
    expect(fx.line("scout-main", message.id)!.bugReport).toEqual({ id: "report-1", status: "received" });
    expect(keptFile(fx).tracked).toEqual([expect.objectContaining({ reportId: "report-1", messageId: message.id, status: "received" })]);
    fx.stop();
  });

  it("shows the public issue and a joined report on the draft's line, and tracks both", async () => {
    const fx = fixture({ outcomes: [{ ok: true, id: "report-7", issue: 42 }, { ok: true, id: "report-8", issue: 42, joined: true }] });
    const one = fx.person("scout-main", "@devs the calendar never syncs");
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(await fx.press("scout-main", one.id)).toMatchObject({ state: "sent", issue: 42 });
    expect(fx.offer("scout-main", one.id)).toMatchObject({ state: "sent", issue: 42 });
    const two = fx.person("rover-main", "@devs the calendar never syncs");
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(await fx.press("rover-main", two.id)).toMatchObject({ state: "joined", issue: 42 });
    expect(fx.offer("rover-main", two.id)).toMatchObject({ state: "joined", issue: 42 });
    expect(keptFile(fx).tracked.map((entry: { reportId: string }) => entry.reportId)).toEqual(["report-7", "report-8"]);
    expect(fx.notices("scout-main")).toEqual([]);
    fx.stop();
  });

  it("shows only the public issue number when the earlier report is another person's, and the title when it is the same person's", async () => {
    const fx = fixture({ outcomes: [{ ok: true, id: "report-7", issue: 123 }] });
    const error = "TypeError: x is not a function";
    const ada = fx.reports.fromError("scout-main", error, "key-ada")!;
    expect(await fx.reports.sendDraft(ada.id, "key-ada")).toMatchObject({ state: "sent", issue: 123 });
    const bo = fx.reports.fromError("scout-main", error, "key-bo")!;
    expect(bo.same).toEqual({ issue: 123 });
    expect(bo.same).not.toHaveProperty("title");
    expect(bo.same).not.toHaveProperty("at");
    fx.advance(NO_ANSWER_MS);
    expect(fx.reports.fromError("scout-main", error, "key-ada")!.same).toMatchObject({ issue: 123, title: ada.title });
    fx.stop();
  });

  it("is only for the person it is for: another reader cannot see it, send it or put it away", async () => {
    const fx = fixture({ reactorOf: (sender) => (sender === "p-ada" ? "key-ada" : "user") });
    const message = fx.person("scout-main", "@devs it broke", { sender: { name: "Ada", id: "p-ada" } });
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    const shown = fx.offer("scout-main", message.id)!;
    expect(shown).toMatchObject({ for: "key-ada", state: "offer" });
    expect(fx.reports.draftThread(shown.id)).toBe("scout-main");
    expect(fx.reports.viewDraft(shown.id, "user")).toBeNull();
    expect(await fx.reports.sendDraft(shown.id, "user")).toEqual({ error: "gone" });
    expect(fx.reports.dismissDraft(shown.id, "user")).toBe("gone");
    expect(fx.sent).toEqual([]);
    expect(await fx.press("scout-main", message.id, "key-ada")).toMatchObject({ state: "sent" });
    expect(fx.sent).toHaveLength(1);
    fx.stop();
  });

  it("is put away with \"Not now\": the line goes, and nothing is sent later", async () => {
    const fx = fixture();
    const message = fx.person("scout-main", "@devs it broke");
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    const { id } = fx.offer("scout-main", message.id)!;
    expect(fx.reports.dismissDraft(id, "user")).toBe("ok");
    expect(fx.offer("scout-main", message.id)).toBeUndefined();
    expect(fx.reports.viewDraft(id, "user")).toBeNull();
    expect(await fx.reports.sendDraft(id, "user")).toEqual({ error: "gone" });
    expect(fx.reports.dismissDraft(id, "user")).toBe("gone");
    fx.advance(RETRY_MS.at(-1)! * 2);
    await fx.settle();
    expect(fx.sent).toEqual([]);
    expect(keptFile(fx).drafts).toEqual([]);
    fx.stop();
  });

  it("goes with its conversation", async () => {
    const fx = fixture();
    const message = fx.person("scout-main", "@devs it broke");
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    const { id } = fx.offer("scout-main", message.id)!;
    expect(keptFile(fx).drafts).toHaveLength(1);
    fx.drop("scout-main");
    expect(fx.reports.draftThread(id)).toBeNull();
    expect(fx.reports.viewDraft(id, "user")).toBeNull();
    expect(keptFile(fx).drafts).toEqual([]);
    fx.stop();
  });

  it("is let go after a week nobody sent it, with its line", async () => {
    const fx = fixture({ answer: () => null });
    const message = fx.person("scout-main", "@devs it broke");
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(fx.offer("scout-main", message.id)).toMatchObject({ state: "offer" });
    fx.advance(TOO_OLD_MS);
    await fx.settle();
    expect(fx.offer("scout-main", message.id)).toBeUndefined();
    expect(keptFile(fx).drafts).toEqual([]);
    expect(fx.sent).toEqual([]);
    fx.stop();
  });
});

describe("a report that cannot go yet", () => {
  it("is saved when the person sends it, and goes on its own later without a second press", async () => {
    const fx = fixture({ outcomes: [{ ok: false, retry: true, why: "offline" }, { ok: false, retry: true, why: "limited", retryAfterMs: 20 * 60_000 }] });
    const message = fx.person("scout-main", "@devs offline");
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(fx.sent).toEqual([]);
    expect(await fx.press("scout-main", message.id)).toMatchObject({ state: "saved" });
    expect(fx.sent).toHaveLength(1);
    const { id } = fx.offer("scout-main", message.id)!;
    expect(fx.offer("scout-main", message.id)).toMatchObject({ state: "saved" });
    expect(fx.notices("scout-main")).toEqual([]);
    const saved = keptFile(fx);
    expect(saved.outbox).toHaveLength(1);
    expect(saved.outbox[0].draftId).toBe(id);
    expect(saved.outbox[0].payload.description).toContain("offline");

    fx.advance(RETRY_MS[0]);
    await fx.settle();
    expect(fx.sent).toHaveLength(2);
    expect(fx.offer("scout-main", message.id)).toMatchObject({ state: "saved" });
    fx.advance(19 * 60_000);
    await fx.settle();
    expect(fx.sent).toHaveLength(2);
    fx.advance(60_000);
    await fx.settle();
    expect(fx.sent).toHaveLength(3);
    expect(fx.sent[2]).toEqual(fx.sent[0]);
    expect(fx.offer("scout-main", message.id)).toMatchObject({ id, state: "sent" });
    expect(fx.line("scout-main", message.id)!.bugReport).toEqual({ id: "report-3", status: "received" });
    expect(fx.notices("scout-main")).toEqual([]);
    expect(keptFile(fx).outbox).toEqual([]);
    fx.stop();
  });

  it("is refused by the endpoint: the person is told it was not sent, the draft stays, and they may send it again", async () => {
    const fx = fixture({ outcomes: [{ ok: false, retry: false, why: "refused", detail: "description must be 1 to 10,000 characters of text." }] });
    const message = fx.person("scout-main", "@devs refused");
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(await fx.press("scout-main", message.id)).toEqual({ error: "refused", detail: "description must be 1 to 10,000 characters of text." });
    expect(fx.offer("scout-main", message.id)).toMatchObject({ state: "offer" });
    expect(keptFile(fx).outbox).toEqual([]);
    expect(fx.notices("scout-main")).toEqual([]);
    fx.advance(RETRY_MS.at(-1)! * 2);
    await fx.settle();
    expect(fx.sent).toHaveLength(1);
    expect(await fx.press("scout-main", message.id)).toMatchObject({ state: "sent" });
    expect(fx.sent).toHaveLength(2);
    fx.stop();
  });

  it("is a draft again when the endpoint refuses the saved report, or it grew too old, and its line says so without a system line", async () => {
    const fx = fixture({ outcomes: [{ ok: false, retry: true, why: "offline" }, { ok: false, retry: false, why: "refused", detail: "no." }] });
    const refused = fx.person("scout-main", "@devs refused later");
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(await fx.press("scout-main", refused.id)).toMatchObject({ state: "saved" });
    fx.advance(RETRY_MS[0]);
    await fx.settle();
    expect(fx.sent).toHaveLength(2);
    expect(fx.offer("scout-main", refused.id)).toMatchObject({ state: "offer" });
    expect(keptFile(fx).outbox).toEqual([]);
    expect(fx.notices("scout-main")).toEqual([]);
    expect(await fx.press("scout-main", refused.id)).toMatchObject({ state: "sent" });
    expect(fx.sent).toHaveLength(3);
    fx.stop();

    const old = fixture({ outcomes: [{ ok: false, retry: true, why: "offline" }, { ok: false, retry: true, why: "offline" }] });
    const stale = old.person("scout-main", "@devs offline for days");
    old.advance(NO_ANSWER_MS);
    await old.settle();
    expect(await old.press("scout-main", stale.id)).toMatchObject({ state: "saved" });
    old.advance(TOO_OLD_MS);
    await old.settle();
    expect(old.offer("scout-main", stale.id)).toMatchObject({ state: "offer" });
    expect(keptFile(old).outbox).toEqual([]);
    expect(old.notices("scout-main")).toEqual([]);
    old.stop();
  });

  it("still sends a report an older version saved, with the older system lines in the person's language", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-devs-reports-"));
    dirs.push(dataDir);
    const payload = { installId: "4b7c1f2e-0a9d-4c2b-9f1e-6d5a4b3c2d1e", source: "bot", description: "it broke", appVersion: "0.1.128", platform: "linux x64, desktop app", diagnostics: "Bot: Scout (scout)" };
    const due = Date.UTC(2026, 9, 27, 9, 0);
    writeFileSync(join(dataDir, DEVS_REPORTS_FILE), JSON.stringify({ version: 1, waiting: [], tracked: [], outbox: [
      { messageId: "scout-main:m1", threadId: "scout-main", payload: { ...payload, contactEmail: "ada@example.com" }, firstAt: due - 60_000, attempts: 1, nextAt: due, person: "p-ada" },
      { messageId: "rover-main:m1", threadId: "rover-main", payload, firstAt: due - 60_000, attempts: 1, nextAt: due },
    ] }));
    const fx = fixture({ dataDir, lineLanguage: (person) => (person === "p-ada" ? "de" : undefined),
      outcomes: [{ ok: true, id: "report-1" }, { ok: false, retry: false, why: "refused", detail: "no." }] });
    await fx.settle();
    expect(fx.sent).toHaveLength(2);
    expect(fx.notices("scout-main")).toEqual([`notice: ${laterLine("report-1", "ada@example.com", "de")}`]);
    expect(laterLine("report-1", "ada@example.com", "de")).not.toBe(laterLine("report-1", "ada@example.com", "en"));
    expect(fx.notices("rover-main")).toEqual([`notice: ${refusedLine("no.", undefined)}`]);
    const kept = keptFile(fx);
    expect(kept.outbox).toEqual([]);
    expect(kept.tracked).toEqual([expect.objectContaining({ reportId: "report-1", threadId: "scout-main", person: "p-ada" })]);
    fx.stop();
  });

  it("keeps a draft across a restart, and a draft nobody wrote yet is made after it, without waiting for a bot that is no longer working", async () => {
    const first = fixture();
    const message = first.person("scout-main", "@devs before the restart");
    first.stop();
    expect(first.sent).toEqual([]);
    const second = fixture({ dataDir: first.dataDir, threads: first.threads });
    await second.settle();
    expect(second.sent).toEqual([]);
    expect(second.view("scout-main", message.id)!.description).toContain("Seira restarted before a bot wrote one");
    second.stop();
    const third = fixture({ dataDir: first.dataDir, threads: first.threads });
    await third.settle();
    expect(third.offers("scout-main")).toHaveLength(1);
    expect(await third.press("scout-main", message.id)).toMatchObject({ state: "sent" });
    expect(third.sent).toHaveLength(1);
    expect(third.sent[0]!.description).toContain("Seira restarted before a bot wrote one");
    third.stop();
    writeFileSync(join(first.dataDir, DEVS_REPORTS_FILE), "not json");
    const fourth = fixture({ dataDir: first.dataDir });
    await fourth.settle();
    expect(fourth.sent).toEqual([]);
    fourth.stop();
  });
});

describe("a group chat", () => {
  it("drafts from the bot handling the message, and a second bot is told it already exists", async () => {
    const fx = fixture();
    const message = fx.person("room", "@devs the room is stuck");
    fx.busy.add("room");
    expect(fx.reports.note("room", true)).toContain("report_bug");
    expect((await fx.call("rover", "room", { went_wrong: "The room is stuck" })).status).toBe(200);
    expect(fx.reports.note("room", true)).toBe("");
    expect((await fx.call("scout", "room", { went_wrong: "The room is stuck" })).body.text).toMatch(/^Already prepared/);
    fx.bot("room", "Done.", { from: { botId: "rover", name: "Rover", color: "blue" }, turnId: "t1", turnSucceeded: true });
    fx.busy.delete("room");
    await fx.settle();
    expect(fx.sent).toEqual([]);
    expect(fx.offers("room")).toHaveLength(1);
    expect(fx.offer("room", message.id)).toMatchObject({ by: "Rover", state: "offer" });
    await fx.press("room", message.id);
    expect(fx.sent).toHaveLength(1);
    expect(fx.sent[0]!.description).toContain("Where: the group chat \"Launch\" with 2 bots");
    expect(fx.sent[0]!.diagnostics).toContain("Group chat: launch");
    expect(fx.sent[0]!.diagnostics).toContain("Bot: Rover (rover)");
    expect(fx.sent[0]!.diagnostics).not.toContain("Bot: Scout (scout)");
    expect(fx.notices("room")).toEqual([]);
    fx.stop();
  });

  it("still drafts the facts for a message no bot answers", async () => {
    const fx = fixture();
    const message = fx.person("room", "@devs @Bob this page is blank");
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(fx.sent).toEqual([]);
    const draft = fx.view("room", message.id)!;
    expect(draft.diagnostics).toContain("Bot: Scout (scout)");
    expect(draft.diagnostics).toContain("Bot: Rover (rover)");
    fx.stop();
  });
});

describe("closing the loop on a report", () => {
  /** Every report asked about, answered as the MausBot team would: `fixedIn` for all of them, `notify` as given. */
  const team = (state: { status: "received" | "fixed"; fixedIn: string | null; notify: boolean }) => (question: ReportStatusQuestion): ReportStatusAnswer =>
    ({ reports: question.ids.map((id) => ({ id, status: state.status, fixedIn: state.fixedIn })), notify: state.notify });
  /** A report from Scout's chat by Bob, with Scout's summary, that Bob sent; the person's message. */
  async function reported(fx: ReturnType<typeof fixture>, words = "@devs the calendar never syncs") {
    const message = fx.person("scout-main", words, { sender: { name: "Bob", id: "p_bob_bob_bob_bob_bob_bob_bob" } });
    fx.busy.add("scout-main");
    fx.reports.note("scout-main", true);
    expect((await fx.call("scout", "scout-main", { went_wrong: "The calendar never syncs" })).status).toBe(200);
    fx.busy.delete("scout-main");
    await fx.settle();
    expect(await fx.press("scout-main", message.id)).toMatchObject({ state: "sent" });
    return message;
  }
  const fixedLines = (fx: ReturnType<typeof fixture>) => fx.notices("scout-main").filter((name) => name.startsWith("notice: Fixed in"));
  const later = async (fx: ReturnType<typeof fixture>, ms: number) => { fx.advance(ms); await fx.settle(); };

  it("shows the person their report's status on the message that sent it: got it, then fixed and coming, without a word in the chat until it runs here", async () => {
    const state = { status: "received" as "received" | "fixed", fixedIn: null as string | null, notify: true };
    const fx = fixture({ appVersion: "0.1.128", answer: team(state) });
    const message = await reported(fx);
    expect(fx.line("scout-main", message.id)!.bugReport).toEqual({ id: "report-1", status: "received" });
    const kept = JSON.parse(readFileSync(join(fx.dataDir, DEVS_REPORTS_FILE), "utf8"));
    expect(kept.tracked).toEqual([expect.objectContaining({ reportId: "report-1", threadId: "scout-main", messageId: message.id, status: "received",
      installId: "4b7c1f2e-0a9d-4c2b-9f1e-6d5a4b3c2d1e", person: "p_bob_bob_bob_bob_bob_bob_bob", words: "the calendar never syncs" })]);
    // The first question goes a minute after a start, with this install's id and its open reports.
    await later(fx, STATUS_FIRST_MS - 1_000);
    expect(fx.asked).toEqual([]);
    await later(fx, 1_000);
    expect(fx.asked).toEqual([{ installId: "4b7c1f2e-0a9d-4c2b-9f1e-6d5a4b3c2d1e", ids: ["report-1"] }]);
    // Fixed, the release not known yet; then known, but this app runs an older one.
    Object.assign(state, { status: "fixed", fixedIn: null });
    await later(fx, STATUS_EVERY_MS);
    expect(fx.line("scout-main", message.id)!.bugReport).toEqual({ id: "report-1", status: "fixed" });
    Object.assign(state, { fixedIn: "0.1.129" });
    await later(fx, STATUS_EVERY_MS);
    expect(fx.line("scout-main", message.id)!.bugReport).toEqual({ id: "report-1", status: "fixed", fixedIn: "0.1.129" });
    expect(fx.asked).toHaveLength(3);
    expect([fixedLines(fx), fx.told]).toEqual([[], []]);
    fx.stop();
  });

  it("tells the person once, in the chat they reported in, only once this app runs the fix's release, and the bot's next turn there knows why", async () => {
    const state = { status: "fixed" as const, fixedIn: "0.1.129", notify: true };
    const before = fixture({ appVersion: "0.1.128", answer: team(state) });
    const message = await reported(before);
    await later(before, STATUS_FIRST_MS);
    expect(fixedLines(before)).toEqual([]);
    before.stop();
    // The app updates to the fix's release and starts again: one line, one notification, the message says it runs here.
    const after = fixture({ dataDir: before.dataDir, threads: before.threads, appVersion: "0.1.129", clock: before.now(), answer: team(state) });
    await later(after, STATUS_FIRST_MS);
    expect(fixedLines(after)).toEqual([`notice: ${fixedLine("0.1.129")}`]);
    expect(after.store.activePath("scout-main").at(-1)!.bugReport).toEqual({ id: "report-1", status: "fixed", fixedIn: "0.1.129", running: true });
    expect(after.line("scout-main", message.id)!.bugReport).toEqual({ id: "report-1", status: "fixed", fixedIn: "0.1.129", running: true });
    expect(after.told).toEqual([{ threadId: "scout-main", text: "Fixed in 0.1.129. Want to try again?", person: "p_bob_bob_bob_bob_bob_bob_bob" }]);
    expect(JSON.parse(readFileSync(join(after.dataDir, DEVS_REPORTS_FILE), "utf8")).tracked[0].told).toBe(after.now());
    // Never again: not on the next round, nor after another start.
    for (let round = 0; round < 3; round++) await later(after, STATUS_EVERY_MS);
    expect(after.asked).toHaveLength(1);
    expect(fixedLines(after)).toHaveLength(1);
    expect(after.told).toHaveLength(1);
    // The bot's next turn in that chat is told why, once; another chat's isn't.
    expect(after.reports.note("rover-main", true)).toBe("");
    const note = after.reports.note("scout-main", true);
    expect(note).toContain("is fixed in 0.1.129, which this app now runs");
    expect(note).toContain('("the calendar never syncs")');
    expect(after.reports.note("scout-main", true)).toBe("");
    after.stop();
    const again = fixture({ dataDir: before.dataDir, threads: before.threads, appVersion: "0.1.130", clock: after.now(), answer: team(state) });
    await later(again, STATUS_FIRST_MS + STATUS_EVERY_MS);
    // The same conversation: still the one line it got.
    expect([again.asked, fixedLines(again), again.told]).toEqual([[], [`notice: ${fixedLine("0.1.129")}`], []]);
    expect(again.reports.note("scout-main", true)).toBe("");
    again.stop();
  });

  it("tells a former customer nothing: the team's answer says not to, or they left the team", async () => {
    const state = { status: "fixed" as const, fixedIn: "0.1.128", notify: false };
    const fx = fixture({ appVersion: "0.1.128", answer: team(state) });
    const message = await reported(fx);
    for (let round = 0; round < 3; round++) await later(fx, STATUS_EVERY_MS);
    expect([fixedLines(fx), fx.told]).toEqual([[], []]);
    // Its status still reads on their own message, which only they see.
    expect(fx.line("scout-main", message.id)!.bugReport).toEqual({ id: "report-1", status: "fixed", fixedIn: "0.1.128", running: true });
    // Back as a customer: told then, once.
    state.notify = true;
    await later(fx, STATUS_EVERY_MS);
    expect(fixedLines(fx)).toEqual([`notice: ${fixedLine("0.1.128")}`]);
    expect(fx.told).toHaveLength(1);
    fx.stop();

    const team2 = fixture({ appVersion: "0.1.128", answer: team({ ...state, notify: true }) });
    await reported(team2);
    team2.reports.forget("p_bob_bob_bob_bob_bob_bob_bob");
    await later(team2, STATUS_FIRST_MS);
    expect([team2.asked, fixedLines(team2), team2.told]).toEqual([[], [], []]);
    team2.stop();
  });

  it("asks again after no answer, stops at a report the team doesn't know, and lets go of a report after its time or with its conversation", async () => {
    let answer: ReportStatusAnswer | null = null;
    const fx = fixture({ answer: () => answer });
    await reported(fx);
    await later(fx, STATUS_FIRST_MS);
    await later(fx, STATUS_EVERY_MS);
    expect(fx.asked).toHaveLength(2);
    answer = { reports: [{ id: "report-1", status: "unknown", fixedIn: null }], notify: true };
    await later(fx, STATUS_EVERY_MS);
    await later(fx, STATUS_EVERY_MS);
    expect(fx.asked).toHaveLength(3);
    expect(JSON.parse(readFileSync(join(fx.dataDir, DEVS_REPORTS_FILE), "utf8")).tracked).toEqual([]);
    fx.stop();

    const old = fixture({ answer: () => null });
    await reported(old);
    await later(old, TRACKED_MS);
    expect(old.asked).toEqual([]);
    old.stop();

    const gone = fixture({ answer: () => null });
    await reported(gone);
    gone.drop("scout-main");
    await later(gone, STATUS_FIRST_MS);
    expect(gone.asked).toEqual([]);
    expect(JSON.parse(readFileSync(join(gone.dataDir, DEVS_REPORTS_FILE), "utf8")).tracked).toEqual([]);
    gone.stop();
  });

  it("follows a report that went later, from the outbox, as it follows one that went at once", async () => {
    const fx = fixture({ outcomes: [{ ok: false, retry: true, why: "offline" }], answer: team({ status: "fixed", fixedIn: "0.1.128", notify: true }) });
    const message = fx.person("scout-main", "@devs pictures never load", { sender: { name: "Bob", id: "p_bob_bob_bob_bob_bob_bob_bob" } });
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(await fx.press("scout-main", message.id)).toMatchObject({ state: "saved" });
    expect(fx.line("scout-main", message.id)!.bugReport).toBeUndefined();
    await later(fx, RETRY_MS[0]);
    expect(fx.sent).toHaveLength(2);
    expect(fx.line("scout-main", message.id)!.bugReport).toEqual({ id: "report-2", status: "received" });
    await later(fx, STATUS_EVERY_MS);
    expect(fixedLines(fx)).toEqual([`notice: ${fixedLine("0.1.128")}`]);
    expect(fx.told).toEqual([{ threadId: "scout-main", text: fixedLine("0.1.128"), person: "p_bob_bob_bob_bob_bob_bob_bob" }]);
    expect(fx.reports.note("scout-main", true)).toContain('("pictures never load")');
    fx.stop();
  });
});

describe("a @devs report prepared as a prefilled issue form", () => {
  const FORM = "https://github.com/seira-bot/seira/issues/new?template=bug_report.yml&title=Pictures+never+load";
  const FORM_START = "https://github.com/seira-bot/seira/issues/new?template=bug_report.yml";

  it("is a draft the person opens as a form: no system line, nothing followed, and a second report_bug call is answered", async () => {
    const fx = fixture({ outcomes: [{ ok: true, issueUrl: FORM }], direct: false });
    const message = fx.person("scout-main", "@devs pictures never load");
    fx.busy.add("scout-main");
    fx.reports.note("scout-main", true);
    const answer = await fx.call("scout", "scout-main", { went_wrong: "Pictures never load" });
    expect(answer.status).toBe(200);
    expect(answer.body.text).toBe(readyAnswer(READY));
    expect(fx.sent).toEqual([]);
    const draft = fx.view("scout-main", message.id)!;
    expect(draft.direct).toBe(false);
    expect(draft.formUrl.startsWith(FORM_START)).toBe(true);

    fx.busy.delete("scout-main");
    fx.bot("scout-main", `${READY} Open it on GitHub.`, { turnId: "t1", turnSucceeded: true });
    await fx.settle();
    fx.advance(LONGEST_WAIT_MS * 2);
    await fx.settle();
    expect(fx.sent).toEqual([]);

    expect(await fx.press("scout-main", message.id)).toMatchObject({ state: "opened" });
    expect(fx.sent).toHaveLength(1);
    expect(fx.offer("scout-main", message.id)).toMatchObject({ state: "opened" });
    expect(fx.notices("scout-main")).toEqual([]);
    expect(fx.line("scout-main", message.id)!.bugReport).toBeUndefined();
    const kept = keptFile(fx);
    expect(kept.outbox).toEqual([]);
    expect(kept.tracked).toEqual([]);
    fx.advance(STATUS_FIRST_MS * 2);
    await fx.settle();
    expect(fx.asked).toEqual([]);

    const again = await fx.call("scout", "scout-main", { went_wrong: "again" });
    expect(again.body.text).toMatch(/^Already prepared/);
    expect(fx.offers("scout-main")).toHaveLength(1);
    fx.stop();
  });

  it("makes the draft itself, once, when the bot never calls report_bug", async () => {
    const fx = fixture();
    const message = fx.person("scout-main", "@devs pictures never load");
    fx.advance(NO_ANSWER_MS + 1);
    await fx.settle();
    expect(fx.offer("scout-main", message.id)).toMatchObject({ state: "offer" });
    await fx.settle();
    expect(fx.offers("scout-main")).toHaveLength(1);
    expect(fx.sent).toEqual([]);
    fx.stop();
  });

  it("sends no network request when no report address is set, even when the person sends the draft", async () => {
    const calls: string[] = [];
    const fetcher = (async (url: string) => { calls.push(url); throw new Error("offline"); }) as unknown as typeof fetch;
    const fx = fixture({ send: devsReportSender(null, fetcher), direct: false });
    const message = fx.person("scout-main", "@devs pictures never load");
    fx.busy.add("scout-main");
    fx.reports.note("scout-main", true);
    const answer = await fx.call("scout", "scout-main", { went_wrong: "Pictures never load" });
    expect(answer.body.text).toMatch(/^Ready for the person to review\./);
    expect(fx.view("scout-main", message.id)!.formUrl.startsWith(FORM_START)).toBe(true);
    expect(await fx.press("scout-main", message.id)).toMatchObject({ state: "opened" });
    expect(calls).toEqual([]);
    expect(fx.notices("scout-main")).toEqual([]);
    fx.stop();
  });
});
