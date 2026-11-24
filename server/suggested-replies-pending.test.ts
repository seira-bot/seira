import { describe, expect, it } from "vitest";
import { OUTSIDE, requestWorkOrigin } from "./peer-provenance.ts";
import { PendingSuggestedReplies, personStartedTurn, type SuggestionRequest } from "./suggested-replies-pending.ts";

const G = "gen-1";
const person = (over: Partial<SuggestionRequest> = {}): SuggestionRequest =>
  ({ generation: G, generations: new Set([G]), kind: "person", origin: { kind: "user" }, ...over });
const chip = (n: number) => ({ title: `Chip ${n}`, prompt: `Please do thing ${n}.` });

describe("chips held for a running turn", () => {
  it("keeps at most 4 cleaned entries and hands them over once", () => {
    const pending = new PendingSuggestedReplies();
    expect(pending.offer("t", G, person(), [chip(1), chip(2), { title: "", prompt: "empty title" }, chip(3), chip(4), chip(5)])).toBe(4);
    expect(pending.take("t", G, person())).toEqual([chip(1), chip(2), chip(3), chip(4)]);
    expect(pending.take("t", G, person())).toBeUndefined();
  });

  it("drops links, commands, shell text and oversized text", () => {
    const pending = new PendingSuggestedReplies();
    const bad = [
      { title: "Link", prompt: "Open https://example.test now." }, { title: "Slash", prompt: "/clear everything" },
      { title: "Shell", prompt: "git push --force" }, { title: "Long", prompt: "x".repeat(501) },
      { title: "T".repeat(41), prompt: "Fine prompt." }, { title: "Run it", prompt: "sudo rm -rf /" },
    ];
    expect(pending.offer("t", G, person(), bad)).toBe(0);
    expect(pending.take("t", G, person())).toBeUndefined();
  });

  it("drops an entry that holds a secret instead of changing what a tap sends", () => {
    const pending = new PendingSuggestedReplies();
    expect(pending.offer("t", G, person(), [{ title: "Use key", prompt: "Use the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 for it." }, chip(1)])).toBe(1);
    expect(pending.take("t", G, person())).toEqual([chip(1)]);
  });

  it("keeps each thread apart, replaces an earlier offer and forgets when a turn starts", () => {
    const pending = new PendingSuggestedReplies();
    pending.offer("a", G, person(), [chip(1)]);
    pending.offer("b", G, person(), [chip(2)]);
    pending.offer("a", G, person(), [chip(3)]);
    expect(pending.take("a", G, person())).toEqual([chip(3)]);
    pending.clear("b");
    expect(pending.take("b", G, person())).toBeUndefined();
    pending.offer("c", G, person(), [chip(1)]);
    pending.offer("c", G, person(), "not a list");
    expect(pending.take("c", G, person())).toBeUndefined();
  });
});

describe("chips need a turn that a person started and that is still the same turn", () => {
  const offerThenTake = (request: SuggestionRequest | undefined, takeGeneration: string | undefined = G, takeRequest = request) => {
    const pending = new PendingSuggestedReplies();
    const kept = pending.offer("t", G, request, [chip(1)]);
    return { kept, taken: pending.take("t", takeGeneration, takeRequest) };
  };

  it("keeps the list for a person's own turn", () => {
    expect(offerThenTake(person())).toEqual({ kept: 1, taken: [chip(1)] });
    expect(offerThenTake(person({ personLine: true }))).toEqual({ kept: 1, taken: [chip(1)] });
  });

  it.each(["routine", "webhook", "api", "handoff", "continuation"])("keeps nothing for a %s turn", (kind) => {
    expect(offerThenTake(person({ kind }))).toEqual({ kept: 0, taken: undefined });
  });

  it("keeps nothing when no proof says a person wrote the request", () => {
    expect(offerThenTake(person({ origin: { kind: "outside" } }))).toEqual({ kept: 0, taken: undefined });
    expect(offerThenTake(undefined)).toEqual({ kept: 0, taken: undefined });
  });

  it("never lets the person-line flag stand in for an outside or absent origin", () => {
    for (const origin of [{ kind: "outside" }, undefined, { kind: "" }]) {
      expect(offerThenTake(person({ origin, personLine: true })), JSON.stringify(origin)).toEqual({ kept: 0, taken: undefined });
      expect(personStartedTurn(person({ origin, personLine: true }), G)).toBe(false);
    }
    // A list offered under a good proof is dropped at take when the proof is gone by then.
    const pending = new PendingSuggestedReplies();
    expect(pending.offer("t", G, person(), [chip(1)])).toBe(1);
    expect(pending.take("t", G, person({ origin: { kind: "outside" }, personLine: true }))).toBeUndefined();
  });

  it("drops the list when the person stops the turn, even after the offer", () => {
    const request = person();
    const pending = new PendingSuggestedReplies();
    expect(pending.offer("t", G, request, [chip(1)])).toBe(1);
    expect(pending.take("t", G, { ...request, stopped: true })).toBeUndefined();
    expect(offerThenTake(person({ stopped: true })).kept).toBe(0);
  });

  it("drops a list that an earlier turn offered when a newer turn replaced it", () => {
    const pending = new PendingSuggestedReplies();
    pending.offer("t", G, person(), [chip(1)]);
    const next = person({ generation: "gen-2", generations: new Set(["gen-2"]) });
    expect(pending.take("t", "gen-2", next)).toBeUndefined();
    pending.offer("t", G, person(), [chip(2)]);
    expect(pending.take("t", G, next)).toBeUndefined();
  });

  it("refuses a generation that does not belong to the request", () => {
    expect(personStartedTurn(person(), "gen-other")).toBe(false);
    expect(personStartedTurn(person(), undefined)).toBe(false);
  });

  it("does not let a failed offer leave an older list behind", () => {
    const pending = new PendingSuggestedReplies();
    pending.offer("t", G, person(), [chip(1)]);
    expect(pending.offer("t", G, person({ kind: "routine" }), [chip(2)])).toBe(0);
    expect(pending.take("t", G, person())).toBeUndefined();
  });
});

describe("the host's own origin decides which turn a person started", () => {
  const line = (over: Record<string, unknown> = {}) => ({ role: "user" as const, kind: "text" as const, text: "Please check the build.", ...over });
  const started = (origin: { kind: string }) => personStartedTurn(person({ origin, personLine: true }), G);

  it("counts a person's own typed line", () => {
    expect(started(requestWorkOrigin({ line: line() }))).toBe(true);
  });

  it.each([
    ["an API line", line({ via: "api" })],
    ["a relayed line", line({ relayed: true })],
    ["a bot's ask", line({ peerAsk: true })],
    ["an aside", line({ aside: true })],
    ["a line with no text", line({ text: "   " })],
    ["a line a bot wrote", line({ role: "assistant" })],
    ["a line that is not text", line({ kind: "card" })],
    ["no line", undefined],
  ])("does not count %s", (_name, one) => {
    expect(started(requestWorkOrigin({ line: one as never }))).toBe(false);
  });

  it("does not count a routine, a webhook trigger, a guest or a hand-off that names no person", () => {
    expect(started(requestWorkOrigin({ trigger: "schedule" as never, line: line() }))).toBe(false);
    expect(started(requestWorkOrigin({ guest: true, line: line() }))).toBe(false);
    expect(started(requestWorkOrigin({ handed: OUTSIDE, line: line() }))).toBe(false);
    expect(started(requestWorkOrigin({ continued: OUTSIDE, line: line() }))).toBe(false);
  });
});
