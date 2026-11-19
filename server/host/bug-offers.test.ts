// The bug report a bot writes after Seira's own error: offered under the turn, sent only when the person sends it.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { failedTurnTool } from "../../shared/failed-turn.ts";
import "../server-line-packs.ts";
import type { DevsReportPayload } from "../devs-report.ts";
import type { SendOutcome } from "../devs-report-send.ts";
import type { Message, StoreChange } from "../store.ts";
import { createDevsReports, DEVS_REPORTS_FILE, MAX_DRAFTS_EACH, OFFER_EVERY_MS, RETRY_MS, type DevsReportsDeps } from "./devs-reports.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const SCOUT = { id: "scout", name: "Scout", threadId: "scout-main", modelSelection: { instanceId: "claude", model: "claude-opus-5-5" } };
const SEIRA_STACK = [
  "TypeError: Cannot read properties of undefined (reading 'rows') in /home/rama/Documents/Klien Sinta/sales-report.xlsx",
  "    at readSheet (/home/rama/.local/share/seira/server/drivers/agents-files.ts:212:17)",
].join("\n");
const ASK = "Sinta, please merge sales-report.xlsx with the March numbers and send it to the board before noon.";
const FROM = { botId: "scout", name: "Scout", color: "#888" };
const SERVER_LOG = "2026-11-19T08:59:00.000Z warn engine probe slow";

/** A report service that keeps one issue per fingerprint: a second report about the same error becomes a comment on it. */
function issueService() {
  const issues = new Map<string, number>();
  const comments: number[] = [];
  const received: DevsReportPayload[] = [];
  const send = async (payload: DevsReportPayload): Promise<SendOutcome> => {
    received.push(payload);
    const key = JSON.stringify(payload.fingerprint ?? payload.description);
    const open = issues.get(key);
    if (open) { comments.push(open); return { ok: true, id: `report-${received.length}`, issue: open, joined: true }; }
    const issue = 40 + issues.size + 1;
    issues.set(key, issue);
    return { ok: true, id: `report-${received.length}`, issue };
  };
  return { send, issues, comments, received };
}

function fixture(options: { send?: DevsReportsDeps["send"]; outcomes?: SendOutcome[]; reactorOf?: DevsReportsDeps["reactorOf"]; personNames?: string[] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "seira-bug-offers-"));
  dirs.push(dataDir);
  const listeners = new Set<(change: StoreChange) => void>();
  const threads = new Map<string, Message[]>();
  let ids = 0, clock = Date.UTC(2026, 10, 19, 9, 0);
  const busy = new Set<string>();
  const bots = [SCOUT];
  const store = {
    bots, sections: [],
    bot: (id: string) => bots.find((bot) => bot.id === id) ?? null,
    botByThread: (threadId: string) => bots.find((bot) => bot.threadId === threadId) ?? (threadId === "room" ? SCOUT : null),
    groupByThread: () => undefined,
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
  const deps: DevsReportsDeps = {
    dataDir, store: store as never, installId: "4b7c1f2e-0a9d-4c2b-9f1e-6d5a4b3c2d1e", appVersion: "0.1.179", runsOn: "desktop app",
    working: (threadId) => busy.has(threadId), automated: () => false,
    engine: () => ({ name: "Claude Code", snapshot: { state: "available", authenticated: true } }),
    appsReady: () => false, language: () => "en",
    ...(options.reactorOf ? { reactorOf: options.reactorOf } : {}),
    personNames: () => options.personNames ?? ["Rama Aditya"],
    recentLog: () => [SERVER_LOG],
    send: options.send ?? (async (payload) => { sent.push(payload); return outcomes.shift() ?? { ok: true, id: `report-${sent.length}`, issue: 41 }; }),
    askStatus: async () => null,
    tell: () => {},
    now: () => clock, timer: false,
  };
  const reports = createDevsReports(deps);
  const ask = (threadId: string, text = ASK, sender?: Message["sender"]) =>
    store.appendMessage(threadId, { role: "user", kind: "text", text, sendId: `send-${ids}`, ...(sender ? { sender } : {}) });
  const reply = (threadId: string, text: string) => store.appendMessage(threadId, { role: "bot", kind: "text", text, from: FROM } as Partial<Message> as never);
  const step = (threadId: string, tool: string, output: string) =>
    store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: tool, ok: false, output }, from: FROM } as Partial<Message> as never);
  const turnFailed = (threadId: string, cause: string, flags: Parameters<typeof failedTurnTool>[1] = {}) =>
    store.appendMessage(threadId, { role: "bot", kind: "activity", tool: failedTurnTool(cause, flags), from: FROM } as Partial<Message> as never);
  const settle = async () => { reports.tick(); await reports.idle(); };
  const line = (threadId: string, id: string) => store.activePath(threadId).find((one) => one.id === id);
  const offers = (threadId?: string) => [...threads.entries()].filter(([id]) => !threadId || id === threadId)
    .flatMap(([, lines]) => lines.filter((one) => one.bugOffer !== undefined));
  const notices = () => [...threads.values()].flat().filter((one) => one.kind === "activity" && one.tool?.name.startsWith("notice:"));
  const kept = () => JSON.parse(readFileSync(join(dataDir, DEVS_REPORTS_FILE), "utf8"));
  return { reports, store, sent, busy, ask, reply, step, turnFailed, settle, line, offers, notices, kept, advance: (ms: number) => { clock += ms; } };
}

/** A turn where Seira's own read_sheet step fails and the bot finishes another way. */
async function failedStep(fx: ReturnType<typeof fixture>, threadId = "scout-main", sender?: Message["sender"]) {
  const asked = fx.ask(threadId, ASK, sender);
  fx.busy.add(threadId);
  fx.step(threadId, "mcp__agents__read_sheet", SEIRA_STACK);
  const answer = fx.reply(threadId, "I merged the numbers another way.");
  await fx.settle();
  fx.busy.delete(threadId);
  await fx.settle();
  return { asked, answer };
}

describe("an offer after Seira's own error (AC-01)", () => {
  it("puts one line under the bot's reply once the turn is over, and sends nothing", async () => {
    const fx = fixture();
    fx.ask("scout-main");
    fx.busy.add("scout-main");
    fx.step("scout-main", "mcp__agents__read_sheet", SEIRA_STACK);
    const answer = fx.reply("scout-main", "I merged the numbers another way.");
    await fx.settle();
    expect(fx.offers()).toEqual([]);
    fx.busy.delete("scout-main");
    await fx.settle();

    expect(fx.offers()).toHaveLength(1);
    expect(fx.line("scout-main", answer.id)?.bugOffer).toEqual({ id: expect.any(String), for: "user", from: "error", by: "Scout", state: "offer" });
    expect(fx.sent).toEqual([]);
    expect(fx.notices()).toEqual([]);
    await fx.settle();
    expect(fx.offers()).toHaveLength(1);
  });

  it("puts the line on a failed-turn row itself, and once for a turn that also has a failed step", async () => {
    const fx = fixture();
    fx.ask("scout-main");
    fx.step("scout-main", "mcp__agents__read_sheet", SEIRA_STACK);
    const failed = fx.turnFailed("scout-main", "TypeError: x is not a function");
    await fx.settle();
    expect(fx.offers()).toHaveLength(1);
    expect(fx.line("scout-main", failed.id)?.bugOffer).toMatchObject({ from: "error", state: "offer" });
    const view = fx.reports.viewDraft(fx.line("scout-main", failed.id)!.bugOffer!.id, "user")!;
    expect(view.title).toBe("A turn stops: x is not a function");
    expect(fx.sent).toEqual([]);
  });

  it("offers nothing for an error the person can fix, or for another tool's error (AC-02)", async () => {
    const fx = fixture();
    fx.ask("scout-main");
    fx.turnFailed("scout-main", "TypeError: x is not a function", { setup: true });
    fx.ask("scout-main");
    fx.turnFailed("scout-main", "429 Too Many Requests");
    fx.ask("scout-main");
    fx.step("scout-main", "Bash", SEIRA_STACK);
    fx.reply("scout-main", "done");
    fx.ask("scout-main");
    fx.step("scout-main", "mcp__agents__read_file", "ENOENT: no such file or directory");
    fx.reply("scout-main", "done");
    await fx.settle();
    expect(fx.offers()).toEqual([]);
    expect(fx.sent).toEqual([]);
  });

  it("offers the same error to the same person once a day", async () => {
    const fx = fixture();
    await failedStep(fx);
    await failedStep(fx);
    expect(fx.offers()).toHaveLength(1);
    fx.advance(OFFER_EVERY_MS + 1);
    await failedStep(fx);
    expect(fx.offers()).toHaveLength(2);
    expect(fx.sent).toEqual([]);
  });
});

describe("the draft the person reads (AC-03)", () => {
  it("holds no name, file name, path or message text, and carries the server log only for the person who runs the app", async () => {
    const fx = fixture();
    const { answer } = await failedStep(fx);
    const view = fx.reports.viewDraft(fx.line("scout-main", answer.id)!.bugOffer!.id, "user")!;
    const text = JSON.stringify(view);
    for (const part of ["Sinta", "sales-report", "/home/rama", "March numbers", "Rama Aditya"]) expect(text).not.toContain(part);
    expect(view).toMatchObject({ from: "error", by: "Scout", state: "offer", direct: true, title: "Step read_sheet fails: Cannot read properties of undefined (reading 'rows') in <file>.xlsx" });
    expect(view.diagnostics).toContain("server/drivers/agents-files.ts:212:17");
    expect(view.diagnostics).toContain("engine probe slow");
    expect(view.included).toMatchObject({ version: "0.1.179", model: "claude-opus-5-5" });
    expect(view.formUrl).toMatch(/^https:\/\/github\.com\/seira-bot\/seira\/issues\/new\?/);
  });
});

describe("sending a draft (AC-04, AC-05)", () => {
  it("sends once on the person's press, and the line says the issue", async () => {
    const fx = fixture();
    const { answer } = await failedStep(fx);
    const id = fx.line("scout-main", answer.id)!.bugOffer!.id;
    const [one, two] = await Promise.all([fx.reports.sendDraft(id, "user"), fx.reports.sendDraft(id, "user")]);
    expect(one).toMatchObject({ id, state: "sent", issue: 41 });
    expect(two).toEqual(one);
    expect(fx.sent).toHaveLength(1);
    expect(fx.sent[0]).toMatchObject({ source: "bot", title: "Step read_sheet fails: Cannot read properties of undefined (reading 'rows') in <file>.xlsx",
      fingerprint: { kind: expect.any(String), step: "read_sheet", frame: "readSheet (server/drivers/agents-files.ts)" } });
    expect(fx.sent[0]!.contactEmail).toBeUndefined();
    expect(fx.line("scout-main", answer.id)?.bugOffer).toEqual({ id, for: "user", from: "error", by: "Scout", state: "sent", issue: 41 });
    expect(fx.kept().tracked).toHaveLength(1);
    expect(await fx.reports.sendDraft(id, "user")).toMatchObject({ state: "sent" });
    expect(fx.sent).toHaveLength(1);
    expect(fx.notices()).toEqual([]);
  });

  it("adds a second report about the same error to the open issue, and says so before it goes", async () => {
    const service = issueService();
    const fx = fixture({ send: service.send, reactorOf: (sender) => sender ?? null });
    const first = await failedStep(fx, "scout-main", { id: "ana", name: "Ana Wijaya" });
    const second = await failedStep(fx, "room", { id: "budi", name: "Budi Santoso" });
    const anaDraft = fx.line("scout-main", first.answer.id)!.bugOffer!;
    const budiDraft = fx.line("room", second.answer.id)!.bugOffer!;
    expect(anaDraft.for).toBe("ana");
    expect(budiDraft.for).toBe("budi");

    expect(fx.reports.viewDraft(budiDraft.id, "budi")!.same).toBeUndefined();
    expect(await fx.reports.sendDraft(anaDraft.id, "ana")).toMatchObject({ state: "sent", issue: 41 });
    expect(fx.reports.viewDraft(budiDraft.id, "budi")!.same).toMatchObject({ issue: 41, title: expect.stringContaining("Step read_sheet fails") });
    expect(await fx.reports.sendDraft(budiDraft.id, "budi")).toMatchObject({ state: "joined", issue: 41 });
    expect(fx.line("room", second.answer.id)?.bugOffer).toMatchObject({ state: "joined", issue: 41 });
    expect(service.issues.size).toBe(1);
    expect(service.comments).toEqual([41]);
    expect(service.received).toHaveLength(2);
  });

  it("opens a prefilled issue form where no relay takes reports", async () => {
    const fx = fixture({ outcomes: [{ ok: true, issueUrl: "https://github.com/seira-bot/seira/issues/new?template=bug_report.yml" }] });
    const { answer } = await failedStep(fx);
    const id = fx.line("scout-main", answer.id)!.bugOffer!.id;
    expect(await fx.reports.sendDraft(id, "user")).toMatchObject({ state: "opened" });
    expect(fx.line("scout-main", answer.id)?.bugOffer).toMatchObject({ state: "opened" });
    expect(fx.kept().tracked ?? []).toEqual([]);
  });
});

describe("a draft sent while offline (AC-07)", () => {
  it("is saved and goes on its own, with no second press", async () => {
    const fx = fixture({ outcomes: [{ ok: false, retry: true, why: "offline" }, { ok: true, id: "report-2", issue: 43 }] });
    const { answer } = await failedStep(fx);
    const id = fx.line("scout-main", answer.id)!.bugOffer!.id;
    expect(await fx.reports.sendDraft(id, "user")).toMatchObject({ state: "saved" });
    expect(fx.line("scout-main", answer.id)?.bugOffer).toMatchObject({ state: "saved" });
    expect(fx.kept().outbox).toEqual([expect.objectContaining({ draftId: id })]);
    expect(await fx.reports.sendDraft(id, "user")).toMatchObject({ state: "saved" });
    expect(fx.sent).toHaveLength(1);

    fx.advance(RETRY_MS[0]);
    await fx.settle();
    expect(fx.sent).toHaveLength(2);
    expect(fx.line("scout-main", answer.id)?.bugOffer).toMatchObject({ state: "sent", issue: 43 });
    expect(fx.kept().outbox ?? []).toEqual([]);
    expect(fx.notices()).toEqual([]);
  });

  it("goes back to an offer the person may send again when the service refuses it", async () => {
    const fx = fixture({ outcomes: [{ ok: false, retry: true, why: "offline" }, { ok: false, retry: false, why: "refused", detail: "too long" }] });
    const { answer } = await failedStep(fx);
    const id = fx.line("scout-main", answer.id)!.bugOffer!.id;
    await fx.reports.sendDraft(id, "user");
    fx.advance(RETRY_MS[0]);
    await fx.settle();
    expect(fx.line("scout-main", answer.id)?.bugOffer).toMatchObject({ state: "offer" });
    expect(fx.kept().outbox ?? []).toEqual([]);
  });
});

describe("Not now (AC-10)", () => {
  it("sends nothing, keeps no copy, and takes the line away", async () => {
    const fx = fixture();
    const { answer } = await failedStep(fx);
    const id = fx.line("scout-main", answer.id)!.bugOffer!.id;
    expect(fx.reports.dismissDraft(id, "user")).toBe("ok");
    expect(fx.line("scout-main", answer.id)?.bugOffer).toBeUndefined();
    expect(fx.reports.viewDraft(id, "user")).toBeNull();
    expect(await fx.reports.sendDraft(id, "user")).toEqual({ error: "gone" });
    expect(fx.reports.dismissDraft(id, "user")).toBe("gone");
    const file = fx.kept();
    expect(file.drafts ?? []).toEqual([]);
    expect(file.outbox ?? []).toEqual([]);
    fx.advance(RETRY_MS.at(-1)! * 2);
    await fx.settle();
    expect(fx.sent).toEqual([]);
  });

  it("cannot take back a draft on its way", async () => {
    const fx = fixture({ outcomes: [{ ok: false, retry: true, why: "offline" }] });
    const { answer } = await failedStep(fx);
    const id = fx.line("scout-main", answer.id)!.bugOffer!.id;
    await fx.reports.sendDraft(id, "user");
    expect(fx.reports.dismissDraft(id, "user")).toBe("busy");
  });
});

describe("a draft on a Team or My Cloud server (AC-11)", () => {
  it("opens, goes and goes away only for the person who asked, and carries no server log", async () => {
    const fx = fixture({ reactorOf: (sender) => sender ?? null });
    const { answer } = await failedStep(fx, "room", { id: "ana", name: "Ana Wijaya" });
    const offer = fx.line("room", answer.id)!.bugOffer!;
    expect(offer.for).toBe("ana");
    expect(fx.reports.viewDraft(offer.id, "budi")).toBeNull();
    expect(fx.reports.viewDraft(offer.id, "user")).toBeNull();
    expect(await fx.reports.sendDraft(offer.id, "budi")).toEqual({ error: "gone" });
    expect(fx.reports.dismissDraft(offer.id, "budi")).toBe("gone");
    expect(fx.sent).toEqual([]);

    const view = fx.reports.viewDraft(offer.id, "ana")!;
    expect(view.diagnostics).not.toContain("engine probe slow");
    expect(JSON.stringify(view)).not.toContain("Ana Wijaya");
    expect(await fx.reports.sendDraft(offer.id, "ana")).toMatchObject({ state: "sent" });
    expect(fx.sent).toHaveLength(1);
  });

  it("writes no draft for a line nobody can be named for", async () => {
    const fx = fixture({ reactorOf: (sender) => sender ?? null });
    await failedStep(fx, "room");
    expect(fx.offers()).toEqual([]);
  });

  it("keeps each person's drafts apart: one person's many push out only their own", () => {
    const fx = fixture({ reactorOf: (sender) => sender ?? null });
    fx.ask("scout-main", "hi", { id: "budi", name: "Budi" });
    const budi = fx.reports.fromError("scout-main", "TypeError: budi's own fault is not a function", "budi")!;
    for (let index = 0; index < MAX_DRAFTS_EACH + 5; index += 1) {
      expect(fx.reports.fromError("scout-main", `TypeError: fault${"x".repeat(index)} is not a function`, "ana")).not.toBeNull();
    }
    expect(fx.reports.viewDraft(budi.id, "budi")).not.toBeNull();
    expect(fx.kept().drafts.filter((draft: { for: string }) => draft.for === "ana")).toHaveLength(MAX_DRAFTS_EACH);
  });
});

describe("a failed request in the app", () => {
  it("gets a draft without a line when the error is Seira's own, and the same draft again for the same error", () => {
    const fx = fixture();
    fx.ask("scout-main");
    expect(fx.reports.fromError("scout-main", "signed out: sign in again", "user")).toBeNull();
    const view = fx.reports.fromError("scout-main", "TypeError: x is not a function", "user")!;
    expect(view).toMatchObject({ from: "error", state: "offer", title: "A request fails: x is not a function" });
    expect(fx.reports.fromError("scout-main", "TypeError: x is not a function", "user")!.id).toBe(view.id);
    expect(fx.reports.draftThread(view.id)).toBe("scout-main");
    expect(fx.offers()).toEqual([]);
    expect(fx.sent).toEqual([]);
  });
});
