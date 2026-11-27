import { describe, expect, it } from "vitest";

import { isTodoCommand, parseTodoCommand } from "./todo-command.ts";

const bots = [{ id: "b-felix", name: "Felix" }, { id: "b-rhea", name: "Rhea" }, { id: "b-rhea-pro", name: "Rhea Pro" }];
const local = (day: number, hours: number, minutes = 0, month = 10) => new Date(2026, month, day, hours, minutes, 0, 0).getTime();
const noon = new Date(2026, 10, 27, 12, 0, 0, 0);

describe("parseTodoCommand", () => {
  it("reads a plain title", () => {
    expect(parseTodoCommand("/todo Check the competitors’ December prices", bots, noon)).toEqual({ title: "Check the competitors’ December prices", start: { kind: "free" } });
  });

  it("reads the example with a bot and tomorrow", () => {
    expect(parseTodoCommand("/todo Check the competitors’ December prices @Felix tomorrow", bots, noon)).toEqual({
      title: "Check the competitors’ December prices", botId: "b-felix", start: { kind: "at", at: local(28, 9) },
    });
  });

  it("matches the @name in any case, anywhere, and the longest name first", () => {
    expect(parseTodoCommand("/todo @felix write the notes", bots, noon)?.botId).toBe("b-felix");
    expect(parseTodoCommand("/todo write @FELIX the notes", bots, noon)).toMatchObject({ botId: "b-felix", title: "write the notes" });
    expect(parseTodoCommand("/todo fix the logo @Rhea Pro", bots, noon)).toMatchObject({ botId: "b-rhea-pro", title: "fix the logo" });
    expect(parseTodoCommand("/todo fix the logo @Rhea", bots, noon)).toMatchObject({ botId: "b-rhea", title: "fix the logo" });
  });

  it("keeps an unknown @name in the title", () => {
    expect(parseTodoCommand("/todo ask @Nobody for the file", bots, noon)).toEqual({ title: "ask @Nobody for the file", start: { kind: "free" } });
    expect(parseTodoCommand("/todo mail felix@example.com", bots, noon)).toEqual({ title: "mail felix@example.com", start: { kind: "free" } });
    expect(parseTodoCommand("/todo ask @Felixa", bots, noon)).toEqual({ title: "ask @Felixa", start: { kind: "free" } });
  });

  it("returns no draft for an empty title", () => {
    expect(parseTodoCommand("/todo", bots, noon)).toBeNull();
    expect(parseTodoCommand("/todo   ", bots, noon)).toBeNull();
    expect(parseTodoCommand("/todo @Felix", bots, noon)).toBeNull();
    expect(parseTodoCommand("hello", bots, noon)).toBeNull();
    expect(parseTodoCommand("/todos x", bots, noon)).toBeNull();
  });

  it("puts a clock time today, or tomorrow once it is past", () => {
    expect(parseTodoCommand("/todo call Dana 15:30", bots, noon)).toEqual({ title: "call Dana", start: { kind: "at", at: local(27, 15, 30) } });
    expect(parseTodoCommand("/todo call Dana 9:05", bots, noon)).toEqual({ title: "call Dana", start: { kind: "at", at: local(28, 9, 5) } });
    expect(parseTodoCommand("/todo call Dana 12:00", bots, noon)?.start).toEqual({ kind: "at", at: local(28, 12) });
  });

  it("rolls over midnight and the end of the month", () => {
    const late = new Date(2026, 10, 30, 23, 50, 0, 0);
    expect(parseTodoCommand("/todo backup 23:55", bots, late)?.start).toEqual({ kind: "at", at: new Date(2026, 10, 30, 23, 55).getTime() });
    expect(parseTodoCommand("/todo backup 00:10", bots, late)?.start).toEqual({ kind: "at", at: new Date(2026, 11, 1, 0, 10).getTime() });
    expect(parseTodoCommand("/todo backup tomorrow", bots, late)?.start).toEqual({ kind: "at", at: new Date(2026, 11, 1, 9, 0).getTime() });
    const justAfter = new Date(2026, 11, 31, 0, 5, 0, 0);
    expect(parseTodoCommand("/todo count tomorrow", bots, justAfter)?.start).toEqual({ kind: "at", at: new Date(2027, 0, 1, 9, 0).getTime() });
  });

  it("reads tomorrow with a time", () => {
    expect(parseTodoCommand("/todo send the deck tomorrow 14:00", bots, noon)).toEqual({ title: "send the deck", start: { kind: "at", at: local(28, 14) } });
  });

  it("reads the repeat forms", () => {
    expect(parseTodoCommand("/todo post the digest daily 08:30", bots, noon)).toEqual({ title: "post the digest", start: { kind: "free" }, repeat: { time: "08:30", weekdays: [] } });
    expect(parseTodoCommand("/todo post the digest weekdays 9:00 @Felix", bots, noon)).toEqual({ title: "post the digest", botId: "b-felix", start: { kind: "free" }, repeat: { time: "09:00", weekdays: [1, 2, 3, 4, 5] } });
    expect(parseTodoCommand("/todo Daily Standup DAILY 10:00", bots, noon)?.repeat).toEqual({ time: "10:00", weekdays: [] });
  });

  it("keeps other words and a bad time in the title", () => {
    expect(parseTodoCommand("/todo plan the week", bots, noon)).toEqual({ title: "plan the week", start: { kind: "free" } });
    expect(parseTodoCommand("/todo tomorrow is a holiday", bots, noon)).toEqual({ title: "tomorrow is a holiday", start: { kind: "free" } });
    expect(parseTodoCommand("/todo meet at 25:00", bots, noon)).toEqual({ title: "meet at 25:00", start: { kind: "free" } });
    expect(parseTodoCommand("/todo meet at 9:5", bots, noon)).toEqual({ title: "meet at 9:5", start: { kind: "free" } });
  });

  it("keeps a lone when word as the title", () => {
    expect(parseTodoCommand("/todo tomorrow", bots, noon)).toEqual({ title: "tomorrow", start: { kind: "free" } });
    expect(parseTodoCommand("/todo daily 09:00", bots, noon)?.title).toBe("daily 09:00");
  });

  it("limits the title and folds white space", () => {
    const long = parseTodoCommand(`/todo ${"a".repeat(300)}`, bots, noon);
    expect(long?.title).toHaveLength(120);
    expect(parseTodoCommand("/todo  one\n two   three ", bots, noon)?.title).toBe("one two three");
  });
});

describe("isTodoCommand", () => {
  it("accepts the command at the start only", () => {
    expect(isTodoCommand("/todo x")).toBe(true);
    expect(isTodoCommand("/TODO")).toBe(true);
    expect(isTodoCommand("/todox")).toBe(false);
    expect(isTodoCommand("say /todo")).toBe(false);
  });
});
