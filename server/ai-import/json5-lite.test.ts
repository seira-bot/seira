import { describe, expect, it } from "vitest";

import { Json5Error, parseJson5Lite } from "./json5-lite.ts";

describe("parseJson5Lite", () => {
  it("reads comments, trailing commas, unquoted keys and single quotes", () => {
    const text = `// head\n{ a: 1, 'b': [1, 2,], c: { d: 'x\\'y', }, /* mid */ $e_1: "z", }`;
    expect(parseJson5Lite(text)).toEqual({ a: 1, b: [1, 2], c: { d: "x'y" }, $e_1: "z" });
  });

  it("reads literals and numbers", () => {
    expect(parseJson5Lite("[true, false, null, -1.5e2, +3, .5, 0x1F, Infinity, -Infinity]")).toEqual([true, false, null, -150, 3, 0.5, 31, Infinity, -Infinity]);
    expect(Number.isNaN(parseJson5Lite("NaN"))).toBe(true);
  });

  it("reads escapes and line continuations", () => {
    expect(parseJson5Lite(String.raw`"aA\x42\n\
c"`)).toBe("aAB\nc");
  });

  it("reads plain JSON and a leading byte order mark", () => {
    expect(parseJson5Lite('﻿{"a":{"b":[1,{"c":null}]}}')).toEqual({ a: { b: [1, { c: null }] } });
  });

  it("keeps __proto__ as an own key", () => {
    const value = parseJson5Lite('{"__proto__": {"x": 1}}') as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it.each(["{", "[1,", '{"a" 1}', "{a:}", "'open", "/* open", "{} extra", "tru", "[1 2]", ""])("rejects %j", (text) => {
    expect(() => parseJson5Lite(text)).toThrow(Json5Error);
  });

  it("rejects input nested deeper than the limit", () => {
    expect(() => parseJson5Lite("[".repeat(200) + "]".repeat(200))).toThrow(Json5Error);
  });
});
