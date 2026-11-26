// A reply cut at the output limit while it writes a tool call runs nothing and asks the model for smaller steps.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import { CUT_CALL_NOTE, OUTPUT_LIMIT_CUT } from "./openai-chat-protocol.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

vi.mock("./retry.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./retry.ts")>();
  return { ...actual, computeBackoff: () => 0 };
});

afterEach(() => vi.unstubAllGlobals());

const sse = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
const chunk = (delta: unknown, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const call = (args: string) => ({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "fx_write", arguments: args } }] });
const cutCall = (text = "") => () => sse((text ? chunk({ content: text }) : "") + chunk(call('{"content":"abc')) + chunk({}, "length"));
const fullCall = () => sse(chunk(call("{}")) + chunk({}, "tool_calls"));
const answer = () => sse(chunk({ content: "done" }) + chunk({}, "stop"));

type Message = { role: string; content?: string };

/** `responses[n]` answers chat request n; the last repeats. */
async function runTurn(responses: Array<() => Response>) {
  const dir = mkdtempSync(join(tmpdir(), "seira-chat-cut-"));
  const script = join(dir, "fake-mcp.mjs");
  const receiptFile = join(dir, "receipt.log");
  writeFileSync(script, `#!/usr/bin/env node
    import { appendFileSync } from "node:fs";
    const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\\n")) !== -1) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
        const m = JSON.parse(line);
        if (m.method === "initialize") send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2024-11-05",capabilities:{tools:{}}}});
        else if (m.method === "tools/list") send({jsonrpc:"2.0",id:m.id,result:{tools:[{name:"write",description:"Fixture write",inputSchema:{type:"object",properties:{},additionalProperties:false}}]}});
        else if (m.method === "tools/call") { appendFileSync(${JSON.stringify(receiptFile)}, "write\\n"); send({jsonrpc:"2.0",id:m.id,result:{content:[{type:"text",text:"ok"}]}}); }
      }
    });
  `);
  chmodSync(script, 0o755);
  const bodies: Array<{ messages: Message[] }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    if (!String(input).endsWith("/chat/completions")) return new Response(JSON.stringify({ data: [] }));
    bodies.push(JSON.parse(String(init?.body)));
    return responses[Math.min(bodies.length - 1, responses.length - 1)]();
  }));
  const instance = await OpenAICompatDriver.create({
    instanceId: "cut", displayName: "Synthetic", enabled: true,
    config: OpenAICompatDriver.decodeConfig({ url: "https://api.example.test/v1", apiKeyEnv: "K", model: "fixture" }),
    environment: { K: "synthetic" },
  });
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent((event) => events.push(event));
  try {
    await instance.adapter.sendTurn({
      threadId: "cut", text: "Write the file.", approvalMode: "full",
      integrations: { custom: { fx: { command: script, args: [], env: {} } } },
    });
    await vi.waitFor(() => expect(events.some((event) => event.type === "turn.completed")).toBe(true), { timeout: 10_000 });
    return { events, bodies, receipt: existsSync(receiptFile) ? readFileSync(receiptFile, "utf8").trim().split("\n") : null };
  } finally {
    await instance.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

const retries = (events: RuntimeEvent[]) => events.filter((event) => event.type === "turn.retrying");

describe("a tool call cut at the output limit", () => {
  it("asks the model for smaller steps and finishes on the next reply", async () => {
    const { events, bodies, receipt } = await runTurn([cutCall(), answer]);
    expect(retries(events)).toEqual([expect.objectContaining({ attempt: 1, reason: "output_limit" })]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].messages.at(-1)).toEqual({ role: "user", content: CUT_CALL_NOTE });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    expect(receipt).toBeNull();
  }, 20_000);

  it("ends the turn with a clear error after the third cut reply", async () => {
    const { events, bodies, receipt } = await runTurn([cutCall()]);
    expect(bodies).toHaveLength(3);
    expect(retries(events).map((event) => event.type === "turn.retrying" && event.attempt)).toEqual([1, 2]);
    expect(events.find((event) => event.type === "runtime.error")).toMatchObject({ message: OUTPUT_LIMIT_CUT });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: false });
    expect(receipt).toBeNull();
  }, 20_000);

  it("keeps the answer text that came before the cut call", async () => {
    const { events, bodies } = await runTurn([cutCall("I will write it now."), answer]);
    const kept = events.findIndex((event) => event.type === "item.completed" && event.itemType === "assistant_text" && event.text === "I will write it now.");
    const retry = events.findIndex((event) => event.type === "turn.retrying");
    expect(kept).toBeGreaterThanOrEqual(0);
    expect(kept).toBeLessThan(retry);
    expect(bodies[1].messages.slice(-2)).toEqual([
      { role: "assistant", content: "I will write it now." },
      { role: "user", content: CUT_CALL_NOTE },
    ]);
  }, 20_000);

  it("runs the smaller call that follows", async () => {
    const { events, receipt } = await runTurn([cutCall(), fullCall, answer]);
    expect(receipt).toEqual(["write"]);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
  }, 20_000);
});
