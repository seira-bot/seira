import { describe, expect, it } from "vitest";

import { streamJsonArray, type JsonStreamItem, type JsonStreamOptions } from "./json-stream.ts";

async function* chunked(text: string, sizes: number[]): AsyncGenerator<Buffer> {
  const bytes = Buffer.from(text, "utf8");
  let at = 0;
  let turn = 0;
  while (at < bytes.length) {
    const size = Math.max(1, sizes[turn++ % sizes.length]);
    yield bytes.subarray(at, at + size);
    at += size;
  }
}

async function collect(text: string, sizes: number[] = [64 * 1024], options?: JsonStreamOptions): Promise<JsonStreamItem[]> {
  const items: JsonStreamItem[] = [];
  for await (const item of streamJsonArray(chunked(text, sizes), options)) items.push(item);
  return items;
}

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomValue(random: () => number, depth: number): unknown {
  const pick = random();
  if (depth > 4 || pick < 0.3) {
    const scalars = [null, true, false, Math.floor(random() * 1e6), -1.5e-3, "", 'q"uo\\te', "line\nbreak", "ünï—cödé 𝔘", "a,b]c}d{e[f:g"];
    return scalars[Math.floor(random() * scalars.length)];
  }
  if (pick < 0.65) return Array.from({ length: Math.floor(random() * 4) }, () => randomValue(random, depth + 1));
  const entries = Array.from({ length: Math.floor(random() * 4) }, (_, n) => [`k${n}"x`, randomValue(random, depth + 1)] as const);
  return Object.fromEntries(entries);
}

describe("streamJsonArray", () => {
  it("yields each element of a top-level array", async () => {
    const items = await collect('[{"a":1}, "two", 3, [4,5] ,null]');
    expect(items).toEqual([
      { ok: true, index: 0, value: { a: 1 } },
      { ok: true, index: 1, value: "two" },
      { ok: true, index: 2, value: 3 },
      { ok: true, index: 3, value: [4, 5] },
      { ok: true, index: 4, value: null },
    ]);
  });

  it("gives the same items for any chunk size, down to one byte", async () => {
    const text = JSON.stringify([{ s: 'a"b\\', n: [1, { x: "ü𝔘" }] }, { t: "}]" }, "x"]);
    const whole = await collect(text);
    expect(await collect(text, [1])).toEqual(whole);
    expect(await collect(text, [3, 1, 7])).toEqual(whole);
  });

  it("reads a named top-level array and ignores other members", async () => {
    const text = '{"skip":[1,2,{"chat":[9]}],"name":"chat","chat":[{"id":1},{"id":2}],"after":[3]}';
    const items = await collect(text, [5], { field: "chat" });
    expect(items.map((item) => (item.ok ? item.value : null))).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("skips a too-deep element and goes on", async () => {
    const deep = `${"[".repeat(10)}${"]".repeat(10)}`;
    const items = await collect(`[{"a":1}, ${deep}, {"b":2}]`, [4], { maxDepth: 5 });
    expect(items.map((item) => (item.ok ? "ok" : item.reason))).toEqual(["ok", "too-deep", "ok"]);
  });

  it("skips an element that is exactly at the depth limit only when it is over it", async () => {
    const atLimit = `${"[".repeat(5)}${"]".repeat(5)}`;
    const items = await collect(`[${atLimit}]`, [64], { maxDepth: 5 });
    expect(items[0]?.ok).toBe(true);
  });

  it("skips an element with a string over the limit and goes on", async () => {
    const huge = "x".repeat(2_000);
    const items = await collect(`[{"a":"ok"},{"t":"${huge}"},{"c":"fine"}]`, [100], { maxStringBytes: 1_000 });
    expect(items.map((item) => (item.ok ? "ok" : item.reason))).toEqual(["ok", "too-large", "ok"]);
  });

  it("skips an element over the element limit", async () => {
    const items = await collect(`[{"a":"${"y".repeat(500)}"},{"b":1}]`, [50], { maxElementBytes: 200 });
    expect(items.map((item) => (item.ok ? "ok" : item.reason))).toEqual(["too-large", "ok"]);
  });

  it("reports an element that does not parse and continues", async () => {
    const items = await collect('[{"a":1},{"b":oops},{"c":3}]');
    expect(items.map((item) => (item.ok ? "ok" : item.reason))).toEqual(["ok", "unreadable", "ok"]);
  });

  it("reports a file that ends inside the array", async () => {
    const items = await collect('[{"a":1},{"b":');
    expect(items.map((item) => (item.ok ? "ok" : item.reason))).toEqual(["ok", "unreadable"]);
  });

  it("reports input with no array", async () => {
    expect((await collect("")).map((item) => item.ok)).toEqual([false]);
    expect((await collect('{"a":1}')).map((item) => item.ok)).toEqual([false]);
    expect(await collect("[]")).toEqual([]);
  });

  it("stops reading the source once the array is closed", async () => {
    let pulled = 0;
    async function* source(): AsyncGenerator<Buffer> {
      for (const part of ['[{"a":1}', "]", "trailing", "more"]) {
        pulled++;
        yield Buffer.from(part);
      }
    }
    const items: JsonStreamItem[] = [];
    for await (const item of streamJsonArray(source())) items.push(item);
    expect(items).toHaveLength(1);
    expect(pulled).toBeLessThanOrEqual(2);
  });

  it("matches JSON.parse for random valid arrays in random chunks", async () => {
    const random = makeRandom(7);
    for (let round = 0; round < 150; round++) {
      const values = Array.from({ length: Math.floor(random() * 6) }, () => randomValue(random, 0));
      const text = JSON.stringify(values, null, random() < 0.5 ? 2 : undefined);
      const sizes = Array.from({ length: 4 }, () => 1 + Math.floor(random() * 40));
      const items = await collect(text, sizes);
      expect(items.every((item) => item.ok)).toBe(true);
      expect(items.map((item) => (item.ok ? item.value : undefined))).toEqual(values);
    }
  });

  it("never throws or hangs on random broken JSON", async () => {
    const random = makeRandom(11);
    const noise = ['"', "\\", "{", "}", "[", "]", ",", ":", "\n", "x", "\u0000", "é"];
    for (let round = 0; round < 300; round++) {
      const values = Array.from({ length: 1 + Math.floor(random() * 4) }, () => randomValue(random, 0));
      let text = JSON.stringify(values);
      const edits = 1 + Math.floor(random() * 4);
      for (let edit = 0; edit < edits; edit++) {
        const at = Math.floor(random() * text.length);
        const kind = random();
        if (kind < 0.33) text = text.slice(0, at);
        else if (kind < 0.66) text = text.slice(0, at) + noise[Math.floor(random() * noise.length)] + text.slice(at + 1);
        else text = text.slice(0, at) + noise[Math.floor(random() * noise.length)] + text.slice(at);
      }
      const sizes = Array.from({ length: 3 }, () => 1 + Math.floor(random() * 30));
      const items = await collect(text, sizes, { maxDepth: 6, maxStringBytes: 50 });
      const indexes = items.map((item) => item.index);
      expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
      for (const item of items) {
        if (item.ok) expect(() => JSON.stringify(item.value)).not.toThrow();
      }
    }
  });
});
