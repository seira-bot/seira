import { AI_IMPORT_LIMITS } from "../../shared/ai-import/limits.ts";

export class Json5Error extends Error {}

const ESCAPES: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "0": "\0" };

/** A JSON5 subset: comments, trailing commas, unquoted keys, single quotes, hex and signed numbers. No dependency. */
export function parseJson5Lite(source: string): unknown {
  const text = source.replace(/^﻿/, "");
  let at = 0;

  const fail = (message: string): never => {
    throw new Json5Error(`${message} at ${at}`);
  };

  const skip = (): void => {
    for (;;) {
      const ch = text[at];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === " " || ch === " " || ch === " " || ch === "\v" || ch === "\f") at++;
      else if (ch === "/" && text[at + 1] === "/") {
        while (at < text.length && text[at] !== "\n") at++;
      } else if (ch === "/" && text[at + 1] === "*") {
        const end = text.indexOf("*/", at + 2);
        if (end < 0) fail("Unterminated comment");
        at = end + 2;
      } else return;
    }
  };

  const string = (): string => {
    const quote = text[at++];
    let out = "";
    for (;;) {
      if (at >= text.length) fail("Unterminated string");
      const ch = text[at++];
      if (ch === quote) return out;
      if (ch === "\n" || ch === "\r") fail("Line break in string");
      if (ch !== "\\") {
        out += ch;
        continue;
      }
      const esc = text[at++];
      if (esc === "u" || esc === "x") {
        const len = esc === "u" ? 4 : 2;
        const hex = text.slice(at, at + len);
        if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) fail("Bad escape");
        out += String.fromCharCode(Number.parseInt(hex, 16));
        at += len;
      } else if (esc === "\r") {
        if (text[at] === "\n") at++;
      } else if (esc === "\n" || esc === " " || esc === " ") continue;
      else if (esc === undefined) fail("Unterminated string");
      else out += ESCAPES[esc] ?? esc;
    }
  };

  const identifier = (): string => {
    const match = /^[A-Za-z_$][\w$]*/.exec(text.slice(at, at + 256));
    if (!match) return fail("Unexpected character");
    at += match[0].length;
    return match[0];
  };

  const number = (): number => {
    const match = /^[+-]?(?:Infinity|NaN|0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(text.slice(at, at + 64));
    if (!match) return fail("Bad number");
    at += match[0].length;
    const raw = match[0];
    const sign = raw.startsWith("-") ? -1 : 1;
    const body = raw.replace(/^[+-]/, "");
    if (body === "Infinity") return sign * Infinity;
    if (body === "NaN") return Number.NaN;
    return sign * Number(body);
  };

  const put = (target: object, key: string, value: unknown): void => {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  };

  const value = (depth: number): unknown => {
    if (depth > AI_IMPORT_LIMITS.jsonDepth) fail("Too deep");
    skip();
    const ch = text[at];
    if (ch === "{") {
      at++;
      const out = {};
      for (;;) {
        skip();
        if (text[at] === "}") {
          at++;
          return out;
        }
        const key = text[at] === '"' || text[at] === "'" ? string() : identifier();
        skip();
        if (text[at++] !== ":") fail("Expected :");
        put(out, key, value(depth + 1));
        skip();
        if (text[at] === ",") at++;
        else if (text[at] !== "}") fail("Expected , or }");
      }
    }
    if (ch === "[") {
      at++;
      const out: unknown[] = [];
      for (;;) {
        skip();
        if (text[at] === "]") {
          at++;
          return out;
        }
        out.push(value(depth + 1));
        skip();
        if (text[at] === ",") at++;
        else if (text[at] !== "]") fail("Expected , or ]");
      }
    }
    if (ch === '"' || ch === "'") return string();
    if (ch === undefined) return fail("Unexpected end");
    if (/[A-Za-z_$]/.test(ch) && !text.startsWith("Infinity", at) && !text.startsWith("NaN", at)) {
      const word = identifier();
      if (word === "true") return true;
      if (word === "false") return false;
      if (word === "null") return null;
      return fail("Unexpected word");
    }
    return number();
  };

  const result = value(0);
  skip();
  if (at < text.length) fail("Unexpected trailing text");
  return result;
}
