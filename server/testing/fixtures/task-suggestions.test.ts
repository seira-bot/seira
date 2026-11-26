import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { TASK_SUGGESTION_ICONS } from "../../../packages/phone-protocol/src/task-suggestions.ts";

const fixture = JSON.parse(readFileSync(new URL("task-suggestions.json", import.meta.url), "utf8"));

const DOCUMENTED_KEYS = ["id", "title", "description", "icon", "state", "startedMessageId", "changedAt"];
const suggestionOf = (line: { taskSuggestions: { suggestions: Array<{ id: string; state: string }> } }, id: string) =>
  line.taskSuggestions.suggestions.find((entry) => entry.id === id);

describe("task-suggestions.json contract fixture", () => {
  it("has the card line the phones draw", () => {
    const { card } = fixture;
    expect(card.role).toBe("bot");
    expect(card.text).toContain("Draft the weekly follow-up summary");
    const { suggestions, intro } = card.taskSuggestions;
    expect(typeof intro).toBe("string");
    expect(suggestions.map((entry: { id: string }) => entry.id)).toEqual(["s1", "s2", "s3"]);
    for (const entry of suggestions) {
      expect(entry.state).toBe("open");
      expect(TASK_SUGGESTION_ICONS).toContain(entry.icon);
      expect(entry.title.length).toBeGreaterThan(0);
    }
  });

  it("uses only documented suggestion keys", () => {
    const lines = [
      fixture.card, fixture.hide.body.message, fixture.show.body.message, fixture.start.body.message,
      fixture.startAgain.body.message, ...fixture.page.body.messages.filter((line: { taskSuggestions?: unknown }) => line.taskSuggestions),
    ];
    for (const line of lines) {
      for (const entry of line.taskSuggestions.suggestions) {
        for (const key of Object.keys(entry)) expect(DOCUMENTED_KEYS, `key ${key}`).toContain(key);
      }
    }
  });

  it("hides, shows and starts the first suggestion", () => {
    expect(fixture.hide.status).toBe(200);
    expect(suggestionOf(fixture.hide.body.message, "s1")?.state).toBe("hidden");
    expect(fixture.show.status).toBe(200);
    expect(suggestionOf(fixture.show.body.message, "s1")?.state).toBe("open");
    expect(fixture.start.status).toBe(200);
    expect(suggestionOf(fixture.start.body.message, "s1")?.state).toBe("started");
  });

  it("links the started suggestion to the person's line", () => {
    const { sent, message } = fixture.start.body;
    const started = message.taskSuggestions.suggestions.find((entry: { id: string }) => entry.id === "s1");
    expect(sent.role).toBe("user");
    expect(sent.text).toBe(started.title);
    expect(started.startedMessageId).toBe(sent.id);
    expect(sent.fromTaskSuggestion).toEqual({ messageId: fixture.card.id, suggestionId: "s1" });
  });

  it("refuses a second Start with the current line", () => {
    expect(fixture.startAgain.status).toBe(409);
    expect(fixture.startAgain.body.message.id).toBe(fixture.card.id);
    expect(suggestionOf(fixture.startAgain.body.message, "s1")?.state).toBe("started");
    expect(typeof fixture.startAgain.body.error).toBe("string");
  });

  it("answers 404 for an unknown suggestion", () => {
    expect(fixture.unknown.status).toBe(404);
    expect(typeof fixture.unknown.body.error).toBe("string");
  });

  it("sends message.patch frames for the card", () => {
    const patches = fixture.frames.body.filter((frame: { kind: string }) => frame.kind === "message.patch");
    expect(patches.length).toBeGreaterThanOrEqual(3);
    for (const frame of patches) {
      expect(frame.message.id).toBe(fixture.card.id);
      expect(frame.threadId).toEqual(expect.any(String));
    }
    expect(suggestionOf(patches[0].message, "s1")?.state).toBe("hidden");
    expect(suggestionOf(patches[1].message, "s1")?.state).toBe("open");
    expect(suggestionOf(patches[2].message, "s1")?.state).toBe("started");
  });

  it("shows the final state on the thread page", () => {
    const lines = fixture.page.body.messages;
    const card = lines.find((line: { id: string }) => line.id === fixture.card.id);
    expect(suggestionOf(card, "s1")?.state).toBe("started");
    const sent = lines.find((line: { id: string }) => line.id === fixture.start.body.sent.id);
    expect(sent.fromTaskSuggestion).toEqual({ messageId: fixture.card.id, suggestionId: "s1" });
  });
});
