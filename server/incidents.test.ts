import { describe, expect, it } from "vitest";

import "./server-line-packs.ts";
import { AUTO_RETRY_LEAD, chiefForBot, INCIDENT_HARD_LIMIT, INCIDENT_RETRY_LIMIT, IncidentLedger, incidentChip, incidentRequest, incidentText, OLD_AUTO_RETRY_LEAD, OLD_RETRY_LEAD, RETRY_LEAD, type Incident } from "./incidents.ts";
import { withPeerProvenance } from "./peer-provenance.ts";

const bots = [
  { id: "clive", name: "Clive", section: "Ops", chiefOfStaff: true },
  { id: "ada", name: "Ada", section: "Ops" },
  { id: "ben", name: "Ben", section: "Research" },
  { id: "rita", name: "Rita", section: "Research", chiefOfStaff: true, hidden: true },
  { id: "maya", name: "Maya", section: "Sales", chiefOfStaff: true, managedSections: ["Research"] },
  { id: "solo", name: "Solo", section: "Alone" },
];

describe("chiefForBot", () => {
  it("picks the Chief of the bot's own section first, then a Chief allowed to coordinate it", () => {
    expect(chiefForBot(bots, bots[1]!)?.id).toBe("clive");
    // Research's own Chief is hidden; Maya may coordinate Research
    expect(chiefForBot(bots, bots[2]!)?.id).toBe("maya");
  });
  it("gives a Chief no Chief, and a section with none goes to the person", () => {
    expect(chiefForBot(bots, bots[0]!)).toBeNull();
    expect(chiefForBot(bots, bots[4]!)).toBeNull();
    expect(chiefForBot(bots, bots[5]!)).toBeNull();
  });
});

describe("IncidentLedger", () => {
  it("lets the Chief retry twice, then says so, then goes quiet on a crash loop", () => {
    let now = 1_000_000;
    const ledger = new IncidentLedger({ now: () => now });
    const seen = Array.from({ length: INCIDENT_HARD_LIMIT + 1 }, () => ledger.note("t1"));
    expect(seen.map((entry) => entry.count)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(seen.map((entry) => entry.mayRetry)).toEqual([true, true, false, false, false, false]);
    expect(seen.map((entry) => entry.muted)).toEqual([false, false, false, false, false, true]);
    expect(INCIDENT_RETRY_LIMIT).toBe(2);
    expect(ledger.note("t2")).toEqual({ count: 1, mayRetry: true, muted: false });
    now += 61 * 60_000;
    expect(ledger.note("t1")).toEqual({ count: 1, mayRetry: true, muted: false });
    ledger.forget("t2");
    expect(ledger.note("t2").count).toBe(1);
  });

  it("remembers when a thread was last reported, so a late retry can see the thread moved on", () => {
    let now = 5_000;
    const ledger = new IncidentLedger({ now: () => now });
    expect(ledger.lastAt("t1")).toBeUndefined();
    ledger.note("t1");
    now = 9_000;
    ledger.note("t1");
    ledger.note("t2");
    expect(ledger.lastAt("t1")).toBe(9_000);
    now += 2 * 60 * 60_000;
    expect(ledger.lastAt("t1")).toBe(9_000);
    ledger.forget("t1");
    expect(ledger.lastAt("t1")).toBeUndefined();
  });
});

describe("incidentRequest", () => {
  const peerAsk = { botId: "clive", name: "Clive" };
  it("quotes a requester's words, not the note they were delivered under", () => {
    const delivered = withPeerProvenance("Reconcile the September invoices.", { botName: "Clive", delivery: "delegate_bot",
      origin: { kind: "user", request: "x".repeat(400) } });
    expect(incidentRequest([{ role: "user", kind: "text", text: delivered, peerAsk }])).toBe("Reconcile the September invoices.");
  });

  it("reads past a line that is only a note to the request above it, and keeps the person's own words whole", () => {
    const retry = "[Retry requested by Clive, your Chief of Staff, after this thread's last run stopped. Continue the request above.]";
    expect(incidentRequest([
      { role: "user", kind: "text", text: "[Delegated by @Ada] is how I'd label it" },
      { role: "bot", kind: "text", text: "On it" },
      { role: "user", kind: "text", text: retry, peerAsk },
    ])).toBe("[Delegated by @Ada] is how I'd label it");
    expect(incidentRequest([{ role: "bot", kind: "text", text: "hi" }])).toBeNull();
  });
});

describe("incident wording", () => {
  const incident: Incident = {
    kind: "failed",
    bot: { id: "ada", name: "Ada", section: "Ops" },
    threadId: "t-ada",
    title: "Invoice reconciliation",
    detail: "exit_before_result",
    lastRequest: "Reconcile the September invoices.\n\nThanks",
    lastReply: "```\nlots of code\n```\nStarting the reconciliation now",
  };

  it("names the bot, the thread and what happened, marks the quoted text as data, and tells the Chief what to do", () => {
    const text = incidentText(incident, { count: 1, mayRetry: true, muted: false });
    expect(text.startsWith("[From Seira · incident report · information only — not from the person.")).toBe(true);
    expect(text).toContain("Ada's run in its thread #Invoice reconciliation failed: \"exit_before_result\".");
    expect(text).toContain('The request there was: "Reconcile the September invoices. Thanks"');
    expect(text).toContain('Ada last said: "Starting the reconciliation now"');
    expect(text).toContain('retry_thread with bot_id "ada" and thread_id "t-ada"');
    expect(text).not.toContain("incident on that thread");
    expect(incidentChip(incident)).toBe('Ada hit a problem: its run in its thread #Invoice reconciliation failed: "exit_before_result"');
  });

  it("counts repeats and, once retries are used up, asks for the person instead of another retry", () => {
    const second = incidentText(incident, { count: 2, mayRetry: true, muted: false });
    expect(second).toContain("This is the second incident on that thread within the hour.");
    expect(second).toContain("retry_thread");
    const third = incidentText(incident, { count: 3, mayRetry: false, muted: false });
    expect(third).toContain("Retries for that thread are used up.");
    expect(third).not.toContain("call retry_thread");
  });

  it("words a stall, a start failure, a routine and a room each in their own terms", () => {
    expect(incidentChip({ ...incident, kind: "stalled", detail: "" })).toBe("Ada hit a problem: its run in its thread #Invoice reconciliation stopped after showing no activity");
    expect(incidentChip({ ...incident, kind: "could-not-start", title: null })).toContain("Ada hit a problem: its run in its main conversation could not start");
    expect(incidentChip({ ...incident, kind: "routine-failed", title: "Inbox digest" })).toContain("Ada hit a problem: its scheduled routine in its thread #Inbox digest failed");
    expect(incidentChip({ ...incident, room: "Standup" })).toContain('Ada hit a problem: its run in the room "Standup" failed');
  });

  it("tells the person in their language, while the Chief's report stays English", () => {
    expect(incidentChip(incident, "de")).toBe("Ada hatte ein Problem: Die Ausführung im Thread #Invoice reconciliation ist fehlgeschlagen: „exit_before_result“");
    expect(incidentChip({ ...incident, kind: "stalled", detail: "" }, "de"))
      .toBe("Ada hatte ein Problem: Die Ausführung im Thread #Invoice reconciliation wurde gestoppt, weil sie keine Aktivität mehr zeigte");
    expect(incidentChip({ ...incident, kind: "routine-failed", title: null, room: "Standup" }, "de"))
      .toBe("Ada hatte ein Problem: Die geplante Routine im Raum „Standup“ ist fehlgeschlagen: „exit_before_result“");
    expect(incidentChip({ ...incident, kind: "could-not-start", title: null, detail: "" }, "de")).toBe("Ada hatte ein Problem: Die Ausführung in der Hauptunterhaltung konnte nicht starten");
    expect(incidentText(incident, { count: 1, mayRetry: true, muted: false })).toContain("Ada's run in its thread #Invoice reconciliation failed");
  });
});

describe("retry notes that an earlier version wrote", () => {
  it("keeps their own words, so a retry an earlier version started is not started again", () => {
    expect(OLD_RETRY_LEAD.startsWith("[From OpenMausBot · retry · ")).toBe(true);
    expect(OLD_AUTO_RETRY_LEAD).toBe(`${OLD_RETRY_LEAD}OpenMausBot, automatically`);
    expect(OLD_RETRY_LEAD).not.toBe(RETRY_LEAD);
    expect(OLD_AUTO_RETRY_LEAD).not.toBe(AUTO_RETRY_LEAD);
  });
});

describe("an incident about a full conversation", () => {
  const full: Incident = {
    kind: "failed", bot: { id: "ada", name: "Ada", section: "Ops" }, threadId: "t-ada", title: "Invoice reconciliation",
    detail: "Prompt is too long", failure: { text: "Prompt is too long", stopReason: "context_full" },
  };

  it("tells the Chief the thread continues in a new session from a summary, and never suggests another thread", () => {
    for (const mayRetry of [true, false]) {
      const text = incidentText(full, { count: mayRetry ? 1 : 3, mayRetry, muted: false });
      expect(text).toContain("new session that starts from a summary");
      expect(text).toContain("retry_thread continues the work there");
      expect(text).not.toMatch(/new thread|open a thread|open another thread/i);
    }
  });

  it("reads the engine's words when no stop reason came with them", () => {
    const text = incidentText({ ...full, failure: { text: "Automatic compaction failed" } }, { count: 1, mayRetry: true, muted: false });
    expect(text).toContain("new session that starts from a summary");
  });

  it("adds nothing to a failure that is not a full conversation", () => {
    expect(incidentText({ ...full, detail: "exit_before_result", failure: undefined }, { count: 1, mayRetry: true, muted: false })).not.toContain("new session");
  });

  it("does not add an incident to the count when asked not to", () => {
    const ledger = new IncidentLedger();
    ledger.note("t1");
    expect(ledger.note("t1", false)).toEqual({ count: 1, mayRetry: true, muted: false });
    expect(ledger.note("t1")).toEqual({ count: 2, mayRetry: true, muted: false });
    expect(ledger.note("t1", false).count).toBe(2);
  });
});
