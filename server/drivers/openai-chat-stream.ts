import { completionError, type ProviderBody } from "./openai-chat-refusals.ts";
import { ChatProtocolError, ChatReasoningDetails, ChatToolCalls, StreamTruncatedError, object } from "./openai-chat-protocol.ts";
import type { Completion } from "./openai-chat.ts";

export interface Usage {
  input: number;
  output: number;
}

export interface CompletionJson extends ProviderBody {
  model?: string;
  choices?: Array<{
    index?: number;
    message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; reasoning_details?: unknown; tool_calls?: unknown; function_call?: unknown };
    delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; reasoning_details?: unknown; tool_calls?: unknown; function_call?: unknown };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; cost?: number };
  /** Groq reports streaming usage in its final x_groq envelope. */
  x_groq?: { usage?: CompletionJson["usage"] };
}

export const usageFrom = (usage: CompletionJson["usage"]): Usage | null =>
  usage
    ? { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0 }
    : null;

export const completionUsage = (json: CompletionJson) => json.usage ?? json.x_groq?.usage;

export interface CompletionTrace {
  httpStatus?: number;
  contentType?: string;
  frames: number;
  sawDone: boolean;
  finishReason: string | null;
  malformedFrame: boolean;
  calls?: ChatToolCalls;
}

export const newCompletionTrace = (): CompletionTrace => ({ frames: 0, sawDone: false, finishReason: null, malformedFrame: false });

const traces = new WeakMap<object, CompletionTrace>();

export function attachTrace(error: unknown, trace: CompletionTrace): void {
  if (error !== null && typeof error === "object") traces.set(error, trace);
}

/** Names, codes and sizes only: argument and message text can hold data that the log redaction does not know. */
export function failureEntry(error: Error): Record<string, unknown> {
  const trace = traces.get(error);
  return {
    failed: error.message.slice(0, 300),
    kind: error.name !== "Error" ? error.name : error.constructor.name,
    ...(trace ? {
      httpStatus: trace.httpStatus,
      contentType: trace.contentType,
      finishReason: trace.finishReason,
      sawDone: trace.sawDone,
      frames: trace.frames,
      malformedFrame: trace.malformedFrame,
      toolCalls: trace.calls?.shape() ?? [],
    } : {}),
  };
}

export async function readChatStream(body: ReadableStream<Uint8Array>, input: {
  signal: AbortSignal;
  reasoning: boolean;
  contentText?: (content: unknown) => string;
  onBytes: () => void;
  onDelta?: (delta: string, kind: "assistant_text" | "reasoning_text") => void;
  trace: CompletionTrace;
}): Promise<Completion> {
  let text = "";
  let reasoning = "";
  let protocolReasoning = "";
  let usage: Usage | null = null;
  let sawChoice = false;
  const calls = new ChatToolCalls();
  input.trace.calls = calls;
  const details = new ChatReasoningDetails();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const consumeDataLine = (line: string, atEof = false): boolean => {
    if (!line.startsWith("data:")) return false;
    input.trace.frames += 1;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      input.trace.sawDone = true;
      return true;
    }
    let chunk: CompletionJson;
    try {
      chunk = JSON.parse(data) as CompletionJson;
    } catch {
      // A tail left when the socket closed is an incomplete frame (stop, abort, drop), not a malformed one.
      if (!atEof) input.trace.malformedFrame = true;
      return false;
    }
    const chunkError = completionError(chunk, "streaming completion error");
    if (chunkError) throw chunkError;
    const choice = chunk.choices?.find((row) => row.index === undefined || row.index === 0);
    const delta = choice?.delta;
    if (object(delta)) sawChoice = true;
    calls.add(delta?.tool_calls, true);
    calls.addLegacy(delta?.function_call);
    details.add(delta?.reasoning_details);
    if (choice?.finish_reason) input.trace.finishReason = choice.finish_reason;
    const reasoningPart = delta?.reasoning_content ?? delta?.reasoning;
    if (typeof reasoningPart === "string") protocolReasoning += reasoningPart;
    const reasoningDelta = input.reasoning && typeof reasoningPart === "string"
      ? reasoningPart
      : "";
    const contentDelta = input.contentText ? input.contentText(delta?.content) : typeof delta?.content === "string" ? delta.content : "";
    if (reasoningDelta) {
      reasoning += reasoningDelta;
      input.onDelta?.(reasoningDelta, "reasoning_text");
    }
    if (contentDelta) {
      text += contentDelta;
      input.onDelta?.(contentDelta, "assistant_text");
    }
    const tokenUsage = completionUsage(chunk);
    if (tokenUsage) usage = usageFrom(tokenUsage);
    return false;
  };
  try {
    readLoop: for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        const line = buffer.trim();
        if (line === "data: [DONE]") {
          input.trace.frames += 1;
          input.trace.sawDone = true;
        } else if (line) consumeDataLine(line, true);
        // MiniMax's api.minimax.io/v1 closes the connection after the
        // finish_reason chunk and never sends `[DONE]`.
        if (buffer.trim() === "data: [DONE]" || input.trace.finishReason) break;
        if (!sawChoice) {
          let tail: CompletionJson | undefined;
          try { tail = JSON.parse(buffer) as CompletionJson; } catch { tail = undefined; }
          const bodyError = tail ? completionError(tail, "completion error") : null;
          if (bodyError) throw bodyError;
        }
        throw new StreamTruncatedError("Stream ended before completion");
      }
      input.onBytes();
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 2_000_000) throw new ChatProtocolError("provider stream frame exceeded the size limit");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (consumeDataLine(line)) break readLoop;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  input.signal.throwIfAborted();
  if (!sawChoice) throw new ChatProtocolError("provider returned no streaming completion choice");
  return { text, reasoning, usage, toolCalls: calls.finish(input.trace.finishReason, input.trace.malformedFrame), finishReason: input.trace.finishReason, protocolReasoning, protocolReasoningDetails: details.blocks };
}
