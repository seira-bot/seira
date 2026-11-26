// A failed chat completion writes its finish reason and tool-call shape, never argument text, to the native log.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

const logged = vi.hoisted(() => [] as Array<{ dir: string; msg: Record<string, unknown> }>);

vi.mock("./retry.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./retry.ts")>();
  return { ...actual, computeBackoff: () => 0 };
});
vi.mock("./native.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./native.ts")>();
  return { ...actual, appendNative: (_thread: string, entry: { dir: string; msg: Record<string, unknown> }) => { logged.push(entry); } };
});

afterEach(() => {
  vi.unstubAllGlobals();
  logged.length = 0;
});

const ARGS = '{"content":"PRIVATE-ARGUMENT-TEXT';
const chunk = (delta: unknown, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const sse = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
const filtered = () => sse(
  chunk({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "fx_write", arguments: ARGS } }] })
  + chunk({}, "content_filter") + "data: [DONE]\n\n");
const answer = () => sse(chunk({ content: "done" }) + chunk({}, "stop") + "data: [DONE]\n\n");
const gateway = () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html; charset=utf-8" } });

async function runTurn(reply: () => Response) {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) =>
    String(input).endsWith("/chat/completions") ? reply() : new Response(JSON.stringify({ data: [] }))));
  const instance = await OpenAICompatDriver.create({
    instanceId: "log", displayName: "Synthetic", enabled: true,
    config: OpenAICompatDriver.decodeConfig({ url: "https://api.example.test/v1", apiKeyEnv: "K", model: "fixture" }),
    environment: { K: "synthetic" },
  });
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent((event) => events.push(event));
  try {
    await instance.adapter.sendTurn({ threadId: "log", text: "Write the file.", approvalMode: "full", integrations: {} });
    await vi.waitFor(() => expect(events.some((event) => event.type === "turn.completed")).toBe(true), { timeout: 10_000 });
    return events;
  } finally {
    await instance.dispose();
  }
}

const failures = () => logged.filter((entry) => entry.dir === "in" && "failed" in entry.msg).map((entry) => entry.msg);

describe("the native log of a chat completion", () => {
  it("records the finish reason and the tool-call shape of a failed reply, without argument text", async () => {
    const events = await runTurn(filtered);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: false });
    expect(failures()).toHaveLength(1);
    expect(failures()[0]).toMatchObject({
      httpStatus: 200, contentType: "text/event-stream", finishReason: "content_filter",
      sawDone: true, malformedFrame: false, frames: 3,
      toolCalls: [{ name: "fx_write", hasId: true, argumentChars: ARGS.length }],
    });
    expect(JSON.stringify(logged)).not.toContain("PRIVATE-ARGUMENT-TEXT");
  }, 20_000);

  it("shows the context window and where it came from on the request entry", async () => {
    await runTurn(answer);
    const request = logged.find((entry) => entry.dir === "out");
    expect(request?.msg.contextWindow).toEqual({ tokens: 128_000, source: "default" });
  }, 20_000);

  it("records the HTTP status and content type of each refused attempt", async () => {
    await runTurn(gateway);
    expect(failures().length).toBeGreaterThanOrEqual(1);
    for (const entry of failures()) {
      expect(entry).toMatchObject({ httpStatus: 502, frames: 0 });
      expect(String(entry.contentType)).toMatch(/^text\/html/);
    }
  }, 20_000);

  it("records the finish reason of a clean reply", async () => {
    await runTurn(answer);
    const reply = logged.filter((entry) => entry.dir === "in").at(-1);
    expect(reply?.msg).toMatchObject({ finishReason: "stop" });
    expect(failures()).toHaveLength(0);
  }, 20_000);
});
