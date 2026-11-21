import type { ImportLeftoverReason } from "../../shared/ai-import/bundle.ts";
import { AI_IMPORT_LIMITS } from "../../shared/ai-import/limits.ts";

export type JsonStreamItem =
  | { ok: true; index: number; value: unknown }
  | { ok: false; index: number; reason: Extract<ImportLeftoverReason, "too-deep" | "too-large" | "unreadable"> };

export interface JsonStreamOptions {
  /** Name of a top-level array member. Without it the top-level value itself is the array. */
  field?: string;
  maxDepth?: number;
  maxStringBytes?: number;
  maxElementBytes?: number;
}

const DEFAULT_MAX_ELEMENT_BYTES = 256 * 1024 * 1024;
const KEY_LIMIT = 256;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;

function isSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
}

/**
 * Yields each element of a top-level JSON array, or of a named top-level array member, while holding one element in memory.
 * An element that nests deeper than `maxDepth`, holds a string over `maxStringBytes`, or exceeds `maxElementBytes` is skipped and
 * reported. An element that does not parse is reported and the scan goes on. Broken structure ends the scan with one report.
 */
export async function* streamJsonArray(
  source: AsyncIterable<Uint8Array>,
  options: JsonStreamOptions = {},
): AsyncGenerator<JsonStreamItem, void, undefined> {
  const field = options.field;
  const maxDepth = options.maxDepth ?? AI_IMPORT_LIMITS.jsonDepth;
  const maxString = options.maxStringBytes ?? AI_IMPORT_LIMITS.messageTextBytes;
  const maxElement = options.maxElementBytes ?? DEFAULT_MAX_ELEMENT_BYTES;
  const elementDepth = field === undefined ? 1 : 2;

  let depth = 0;
  let inTarget = false;
  let finished = false;
  let inString = false;
  let escaped = false;
  let stringBytes = 0;

  let expectKey = true;
  let collectingKey = false;
  let keyBytes: number[] = [];
  let keyText = "";
  let keyMatched = false;

  let capturing = false;
  let scalar = false;
  let container = false;
  let skipReason: "too-deep" | "too-large" | null = null;
  let parts: Buffer[] = [];
  let elementBytes = 0;
  let captureFrom = 0;
  let index = 0;

  const startElement = (at: number, isScalar: boolean): void => {
    capturing = true;
    scalar = isScalar;
    skipReason = null;
    parts = [];
    elementBytes = 0;
    captureFrom = at;
  };

  const flush = (chunk: Buffer, end: number): void => {
    if (!capturing) return;
    if (skipReason === null) {
      elementBytes += end - captureFrom;
      if (elementBytes > maxElement) {
        skipReason = "too-large";
        parts = [];
      } else if (end > captureFrom) {
        parts.push(chunk.subarray(captureFrom, end));
      }
    }
    captureFrom = 0;
  };

  const finishElement = (): JsonStreamItem => {
    capturing = false;
    const at = index++;
    if (skipReason !== null) {
      const reason = skipReason;
      parts = [];
      return { ok: false, index: at, reason };
    }
    const body = Buffer.concat(parts).toString("utf8");
    parts = [];
    try {
      return { ok: true, index: at, value: JSON.parse(body) };
    } catch {
      return { ok: false, index: at, reason: "unreadable" };
    }
  };

  for await (const piece of source) {
    const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength);
    const length = chunk.length;
    let i = 0;
    while (i < length) {
      if (inString) {
        let closed = false;
        while (i < length) {
          const byte = chunk[i++];
          if (escaped) {
            escaped = false;
          } else if (byte === BACKSLASH) {
            escaped = true;
          } else if (byte === QUOTE) {
            closed = true;
            break;
          }
          stringBytes++;
          if (collectingKey && keyBytes.length < KEY_LIMIT) keyBytes.push(byte);
        }
        if (stringBytes > maxString && capturing && skipReason === null) {
          skipReason = "too-large";
          parts = [];
        }
        if (!closed) break;
        inString = false;
        if (collectingKey) {
          collectingKey = false;
          keyText = Buffer.from(keyBytes).toString("utf8");
        }
        if (capturing && depth === elementDepth && !container) {
          flush(chunk, i);
          yield finishElement();
        }
        continue;
      }

      const byte = chunk[i];
      i++;
      switch (byte) {
        case QUOTE:
          inString = true;
          escaped = false;
          stringBytes = 0;
          if (!inTarget && field !== undefined && depth === 1 && expectKey) {
            collectingKey = true;
            keyBytes = [];
          } else if (inTarget && depth === elementDepth && !capturing) {
            startElement(i - 1, false);
            container = false;
          }
          break;
        case OPEN_BRACE:
        case OPEN_BRACKET:
          if (!inTarget && field === undefined && depth === 0 && byte === OPEN_BRACKET) {
            inTarget = true;
            depth = 1;
          } else if (!inTarget && field !== undefined && depth === 1 && byte === OPEN_BRACKET && keyMatched && keyText === field) {
            inTarget = true;
            depth = 2;
          } else {
            if (inTarget && depth === elementDepth && !capturing) {
              startElement(i - 1, false);
              container = true;
            }
            depth++;
            if (capturing && depth - elementDepth > maxDepth && skipReason === null) {
              skipReason = "too-deep";
              parts = [];
            }
          }
          break;
        case CLOSE_BRACE:
        case CLOSE_BRACKET:
          depth--;
          if (inTarget && depth < elementDepth) {
            if (capturing) {
              flush(chunk, i - 1);
              yield finishElement();
            }
            finished = true;
            return;
          }
          if (capturing && depth === elementDepth) {
            flush(chunk, i);
            yield finishElement();
          } else if (depth < 0) {
            depth = 0;
          }
          break;
        case COMMA:
          if (inTarget && depth === elementDepth && capturing && scalar) {
            flush(chunk, i - 1);
            yield finishElement();
          } else if (field !== undefined && !inTarget && depth === 1) {
            expectKey = true;
            keyMatched = false;
          }
          break;
        case COLON:
          if (field !== undefined && !inTarget && depth === 1) {
            keyMatched = keyText === field;
            expectKey = false;
          }
          break;
        default:
          if (isSpace(byte)) break;
          if (inTarget && depth === elementDepth && !capturing) {
            startElement(i - 1, true);
            container = false;
          }
          break;
      }
    }
    if (capturing) flush(chunk, length);
  }

  if (!finished) yield { ok: false, index: index++, reason: "unreadable" };
}
