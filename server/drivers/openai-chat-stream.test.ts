import { describe, expect, it } from "vitest";

import { StreamTruncatedError } from "./openai-chat-protocol.ts";
import { attachTrace, failureEntry, newCompletionTrace, readChatStream } from "./openai-chat-stream.ts";

const body = (text: string) => new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new TextEncoder().encode(text));
    controller.close();
  },
});
const frame = (delta: unknown, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const read = (text: string) => {
  const trace = newCompletionTrace();
  const result = readChatStream(body(text), { signal: new AbortController().signal, reasoning: true, onBytes: () => {}, trace });
  return { trace, result };
};
const call = (args: string) => ({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "fx_write", arguments: args } }] });

describe("readChatStream trace", () => {
  it("counts the frames and records the finish reason and [DONE]", async () => {
    const { trace, result } = read(frame({ content: "hi" }) + frame({}, "stop") + "data: [DONE]\n\n");
    await expect(result).resolves.toMatchObject({ text: "hi", finishReason: "stop" });
    expect(trace).toMatchObject({ frames: 3, sawDone: true, finishReason: "stop", malformedFrame: false });
  });

  it("keeps the tool-call shape, and no argument text, of a stream cut mid call", async () => {
    const args = '{"content":"PRIVATE-ARGUMENT-TEXT';
    const { trace, result } = read(frame(call(args)));
    const error = await result.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(StreamTruncatedError);
    expect(trace.calls?.shape()).toEqual([{ name: "fx_write", hasId: true, argumentChars: args.length }]);
    attachTrace(error, trace);
    const entry = failureEntry(error as Error);
    expect(entry).toMatchObject({ finishReason: null, sawDone: false, frames: 1, kind: "StreamTruncatedError" });
    expect(JSON.stringify(entry)).not.toContain("PRIVATE-ARGUMENT-TEXT");
  });

  it("marks a malformed frame in the middle of the stream", async () => {
    const { trace, result } = read(frame({ content: "a" }) + "data: {bad\n\n" + frame(call("{}")) + frame({}, "tool_calls"));
    await result.catch(() => {});
    expect(trace.malformedFrame).toBe(true);
  });

  it("gives only the message and kind for an error without a trace", () => {
    expect(failureEntry(new Error("x"))).toEqual({ failed: "x", kind: "Error" });
  });
});
