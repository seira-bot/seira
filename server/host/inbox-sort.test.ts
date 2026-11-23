import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import type { Decider } from "../decider/index.ts";
import { INBOX_SORT_INSTRUCTIONS } from "../decider/inbox-sort.ts";
import { createInboxSort } from "./inbox-sort.ts";

const READY: AppConfig = { decider: { enabled: true, workersAiToken: "cf_unit_token", workersAiAccountId: "0123456789abcdef0123456789abcdef" } };
const MESSAGE = { from: "Eli", text: "Approve the launch?", notDecisions: ["Build finished."] };

const answer = (choice: "decision" | "news", decision: number) => ({
  ok: true as const, provider: "workersai" as const, latencyMs: 20,
  answers: { type: "choice" as const, choice, pTop: Math.max(decision, 1 - decision), margin: 0.5, probabilities: { decision, news: 1 - decision } },
});
const sorter = (choose: (...args: unknown[]) => unknown, config: AppConfig = READY) => {
  const spy = vi.fn(choose);
  return { calls: spy, sort: createInboxSort({ decider: { choose: spy as unknown as Decider["choose"] }, config: () => config }).sort };
};

describe("sorting a bot's message on the decision model", () => {
  it("returns null without a call when the decision model is off or has no usable account", async () => {
    for (const config of [{}, { decider: { enabled: false } }, { decider: { ...READY.decider, jobs: { inboxSort: false } } }] as AppConfig[]) {
      const f = sorter(async () => answer("decision", 0.99), config);
      expect(await f.sort(MESSAGE)).toBeNull();
      expect(f.calls).not.toHaveBeenCalled();
    }
  });

  it("returns null on a failure, a throw, and a timeout", async () => {
    expect(await sorter(async () => ({ ok: false, reason: "timeout" })).sort(MESSAGE)).toBeNull();
    expect(await sorter(async () => ({ ok: false, reason: "unreachable" })).sort(MESSAGE)).toBeNull();
    expect(await sorter(async () => { throw new Error("boom"); }).sort(MESSAGE)).toBeNull();
  });

  it("marks a decision only at 0.6 or more; anything weaker is news", async () => {
    expect(await sorter(async () => answer("decision", 0.6)).sort(MESSAGE)).toBe("decision");
    expect(await sorter(async () => answer("decision", 0.59)).sort(MESSAGE)).toBe("news");
    expect(await sorter(async () => answer("news", 0.4)).sort(MESSAGE)).toBe("news");
    expect(await sorter(async () => answer("news", 0.9)).sort(MESSAGE)).toBe("news");
  });

  it("asks the inboxSort job with the message and the counter-examples, under a short timeout", async () => {
    const f = sorter(async () => answer("news", 0.1));
    await f.sort(MESSAGE);
    const [seam, state, question, options] = f.calls.mock.calls[0]!;
    expect(seam).toBe("inboxSort");
    expect(state).toEqual({ from: "Eli", message: "Approve the launch?", not_decisions: ["Build finished."] });
    expect(question).toMatchObject({ instructions: INBOX_SORT_INSTRUCTIONS });
    expect(options).toEqual({ timeoutMs: 4_000 });
  });
});
