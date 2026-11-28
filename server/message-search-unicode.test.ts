import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { closeMessageDb, closeMessageSearch, insertMessage, searchMessages, searchMessagesAsync } from "./message-db.ts";

beforeEach(async () => {
  await closeMessageSearch();
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
});
afterEach(async () => { await closeMessageSearch(); closeMessageDb(); });

describe("case-insensitive message search outside ASCII", () => {
  it.each([
    ["ÉCOLE", "école"], ["МОСКВА", "москва"], ["ΑΘΉΝΑ", "αθήνα"], ["ÜBER", "über"],
  ])("finds %s with %s in text and tool names", async (stored, query) => {
    insertMessage("text", { id: "m1", at: 1, role: "user", kind: "text", text: `Discuss ${stored} today` });
    insertMessage("tools", { id: "m2", at: 2, role: "bot", kind: "activity", tool: { name: `Search ${stored}`, ok: true } });
    const hits = searchMessages(query);
    expect(hits.map((one) => one.messageId)).toEqual(["m2", "m1"]);
    expect(hits.map((one) => one.snippet.slice(one.matchStart, one.matchStart + one.matchLength))).toEqual([stored, stored]);
    expect(await searchMessagesAsync(query)).toEqual(hits);
    expect(searchMessages(query, 1, "text").map((one) => one.messageId)).toEqual(["m1"]);
  });

  it("keeps highlights in original string coordinates when lowercasing expands a character", async () => {
    insertMessage("text", { id: "m", at: 1, role: "user", kind: "text", text: "İ prefix İSTANBUL after" });
    for (const [query, match] of [["prefix", "prefix"], ["İSTANBUL", "İSTANBUL"], ["after", "after"]]) {
      const hits = await searchMessagesAsync(query!);
      expect(hits).toHaveLength(1);
      const hit = hits[0]!;
      expect(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength)).toBe(match);
    }
  });

  it("preserves literal wildcard matching and limits for non-ASCII text", async () => {
    insertMessage("text", { id: "literal", at: 1, role: "user", kind: "text", text: "ÉCOLE 10%_\\ fee" });
    insertMessage("text", { id: "decoy", at: 2, role: "user", kind: "text", text: "ÉCOLE 100xx fee" });
    expect((await searchMessagesAsync("école 10%_\\")).map((one) => one.messageId)).toEqual(["literal"]);
    expect((await searchMessagesAsync("école", 1)).map((one) => one.messageId)).toEqual(["decoy"]);
  });
});

describe("search snippets", () => {
  it("show the words of a Markdown reply, not its markup", async () => {
    insertMessage("text", { id: "md", at: 1, role: "bot", kind: "text", text: "## Hasil\n- Ada **2 masalah serius** di `server.ts`, lihat [laporan](https://example.com/r)" });
    const [hit] = await searchMessagesAsync("masalah");
    expect(hit!.snippet).toBe("Hasil Ada 2 masalah serius di server.ts, lihat laporan");
    expect(hit!.snippet.slice(hit!.matchStart, hit!.matchStart + hit!.matchLength)).toBe("masalah");
  });

  it("still finds a query that spells out Markdown", async () => {
    insertMessage("text", { id: "raw", at: 1, role: "user", kind: "text", text: "why does **bold** stay" });
    const [hit] = await searchMessagesAsync("**bold");
    expect(hit!.snippet.slice(hit!.matchStart, hit!.matchStart + hit!.matchLength)).toBe("**bold");
  });
});

describe("search snippets of large and malformed Markdown", () => {
  const highlighted = (hit: { snippet: string; matchStart: number; matchLength: number }) =>
    hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength);

  it("cut a plain snippet around a hit deep inside a message of hundreds of KB", async () => {
    const paragraph = "## Notes\n- See **item** in `file.ts` and [the docs](https://example.com/docs)\n";
    const filler = paragraph.repeat(4_000);
    insertMessage("text", { id: "big", at: 1, role: "bot", kind: "text", text: `${filler}Found **zebra crossing** near [the map](https://example.com/m)\n${filler}` });
    insertMessage("text", { id: "tail", at: 2, role: "bot", kind: "text", text: `${filler}last **zebra** here` });
    const hits = await searchMessagesAsync("zebra");
    expect(hits.map((one) => one.messageId)).toEqual(["tail", "big"]);
    const [tail, big] = hits;
    expect(highlighted(tail!)).toBe("zebra");
    expect(tail!.snippet.startsWith("…")).toBe(true);
    expect(tail!.snippet.endsWith("last zebra here")).toBe(true);
    expect(highlighted(big!)).toBe("zebra");
    expect(big!.snippet).toContain("Found zebra crossing near the map");
    expect(big!.snippet).not.toMatch(/\*\*|\]\(|`/);
    expect(big!.snippet.startsWith("…") && big!.snippet.endsWith("…")).toBe(true);
  });

  it("cut a long line between words, never inside a link target", async () => {
    insertMessage("text", { id: "url", at: 1, role: "bot", kind: "text", text: `See [the file](https://example.com/${"a".repeat(1_000)}) then the target word` });
    const [hit] = await searchMessagesAsync("target");
    expect(hit!.snippet).toBe("…then the target word");
    expect(highlighted(hit!)).toBe("target");
  });

  it("stay fast on one long line of unpaired emphasis, open links and stray backticks", async () => {
    const noise = "**a __b ~~c [d `e ".repeat(5_000);
    insertMessage("text", { id: "bad", at: 1, role: "bot", kind: "text", text: `${noise}needle **x ${noise}` });
    const started = performance.now();
    const [hit] = await searchMessagesAsync("needle");
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(highlighted(hit!)).toBe("needle");
    expect(hit!.snippet.startsWith("…") && hit!.snippet.endsWith("…")).toBe(true);
  });
});
