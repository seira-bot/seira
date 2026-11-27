import { describe, expect, it } from "vitest";

import { todoSeed } from "./todo-seed";

describe("todoSeed", () => {
  it("takes the first line as the title and the other lines as the note", () => {
    expect(todoSeed("Check the prices\nCompare with last year.\nAsk Dana.")).toEqual({
      title: "Check the prices", note: "Compare with last year.\nAsk Dana.", quote: "Check the prices Compare with last year. Ask Dana.",
    });
  });

  it("strips Markdown from the title", () => {
    expect(todoSeed("## **Send** the [invoice](https://example.com/x) to `Dana`").title).toBe("Send the invoice to Dana");
    expect(todoSeed("- Call the bank").title).toBe("Call the bank");
    expect(todoSeed("3. Pay the rent").title).toBe("Pay the rent");
    expect(todoSeed("> a _quoted_ line").title).toBe("a quoted line");
  });

  it("uses the selection instead of the message", () => {
    const seed = todoSeed("A long message with many words.", "many words");
    expect(seed).toEqual({ title: "many words", note: "", quote: "many words" });
  });

  it("puts a long first line in the title and the whole text in the note", () => {
    const long = `${"word ".repeat(40)}end`;
    const seed = todoSeed(long);
    expect(seed.title.length).toBeLessThanOrEqual(120);
    expect(seed.note.startsWith("word word")).toBe(true);
    expect(seed.note.endsWith("end")).toBe(true);
  });

  it("limits the note and the quote", () => {
    const seed = todoSeed(`Title\n${"x".repeat(5000)}`);
    expect(seed.note).toHaveLength(2000);
    expect(seed.quote.length).toBeLessThanOrEqual(500);
  });

  it("returns an empty seed for empty text", () => {
    expect(todoSeed("  \n ")).toEqual({ title: "", note: "", quote: "" });
  });
});
