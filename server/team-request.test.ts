// The team suggestion: Seira's question is a line with no AI call, the person's next line is marked, and a suggestion is
// a card that creates nothing and replaces an older open card.
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { askForTeam, openSuggestion, postTeamSuggestion, settleSuggestion, takeTeamRequest, teamTurnText } from "./team-request.ts";
import { Store, type Message } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const INPUT = { department: "Bakery", summary: "Orders and books.", bots: [{ name: "Baker", role: "Orders", job: "Tracks orders." }, { name: "Books", role: "Bookkeeper", job: "Keeps the books." }] };

function setup() {
  const store = new Store(selection, undefined, undefined, "en");
  const bot = store.createBot({ name: "Seira" });
  const threadId = bot.threadId;
  const say = (text: string, extra: Partial<Message> = {}) => store.appendMessage(threadId, { role: "user", kind: "text", text, ...extra });
  const take = (line: Message, options: { person?: boolean; mounted?: boolean; editedFrom?: string } = {}) =>
    takeTeamRequest(store, { threadId, line, person: options.person ?? true, mounted: options.mounted ?? true, ...(options.editedFrom ? { editedFrom: options.editedFrom } : {}) });
  return { store, bot, threadId, say, take };
}

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("the team question", () => {
  it("posts Seira's own line once, and answers null outside the bot's conversations", () => {
    const s = setup();
    const first = askForTeam(s.store, s.bot.id, s.threadId, "en");
    expect(first?.teamAsk).toBe(true);
    expect(askForTeam(s.store, s.bot.id, s.threadId, "en")?.id).toBe(first?.id);
    expect(askForTeam(s.store, s.bot.id, "missing", "en")).toBeNull();
    expect(askForTeam(s.store, "missing", s.threadId, "en")).toBeNull();
  });

  it("marks the person's next line, once", () => {
    const s = setup();
    askForTeam(s.store, s.bot.id, s.threadId, "en");
    expect(s.take(s.say("I run a bakery"))?.teamRequest).toBe(true);
    expect(s.take(s.say("and another thing"))).toBeNull();
  });

  it("leaves a command and a relayed line alone", () => {
    const s = setup();
    askForTeam(s.store, s.bot.id, s.threadId, "en");
    expect(s.take(s.say("/help"))).toBeNull();
    const t = setup();
    askForTeam(t.store, t.bot.id, t.threadId, "en");
    expect(t.take(t.say("hi", { relayed: true } as Partial<Message>))).toBeNull();
  });

  it("does not mark when the AI has no tools or the line is not the person's", () => {
    const s = setup();
    askForTeam(s.store, s.bot.id, s.threadId, "en");
    expect(s.take(s.say("a bakery"), { mounted: false })).toBeNull();
    expect(s.take(s.say("a bakery"), { person: false })).toBeNull();
  });

  it("keeps a retried line a team request", () => {
    const s = setup();
    askForTeam(s.store, s.bot.id, s.threadId, "en");
    const marked = s.take(s.say("I run a bakery"))!;
    expect(s.take(marked)?.id).toBe(marked.id);
  });

  it("tells the AI to suggest once and create nothing", () => {
    const text = teamTurnText({ text: "I run a bakery" } as Message, false);
    expect(text).toContain("I run a bakery");
    expect(text).toContain("suggest_team");
    expect(text).toContain("nothing exists until they do");
  });
});

describe("the suggestion card", () => {
  it("creates no bot, and marks an older open card replaced", () => {
    const s = setup();
    const before = s.store.bots.length;
    const one = postTeamSuggestion(s.store, s.threadId, "en", INPUT);
    const two = postTeamSuggestion(s.store, s.threadId, "en", { ...INPUT, firstTask: "Plan the week" });
    expect(s.store.bots).toHaveLength(before);
    const lines = s.store.messagesFor(s.threadId);
    expect(lines.find((line) => line.id === one.id)?.teamSuggestion?.state).toBe("replaced");
    expect(openSuggestion(s.store, s.threadId, two.id)?.suggestion.firstTask).toBe("Plan the week");
    expect(openSuggestion(s.store, s.threadId, one.id)).toBeNull();
  });

  it("settles as skipped without an intro, and as created with an intro that names each bot's job", () => {
    const s = setup();
    const card = postTeamSuggestion(s.store, s.threadId, "en", { ...INPUT, firstTask: "Plan the week" });
    const open = openSuggestion(s.store, s.threadId, card.id)!;
    expect(settleSuggestion(s.store, s.threadId, open, "skipped", "en")).toBeNull();
    expect(openSuggestion(s.store, s.threadId, card.id)).toBeNull();

    const next = postTeamSuggestion(s.store, s.threadId, "en", { ...INPUT, firstTask: "Plan the week" });
    const intro = settleSuggestion(s.store, s.threadId, openSuggestion(s.store, s.threadId, next.id)!, "created", "en", {
      department: "Bakery", document: (next.teamSuggestion!.document as never), bots: [{ id: "b1", name: "Baker" }, { id: "b2", name: "Books" }],
    });
    expect(intro?.teamIntro?.bots.map((bot) => bot.job)).toEqual(["Tracks orders.", "Keeps the books."]);
    expect(intro?.teamIntro?.firstTask).toBe("Plan the week");
  });
});
