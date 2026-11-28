import { describe, expect, it } from "vitest";

import {
  ERR,
  TEXT_MAX,
  agentCard,
  cancelTaskParams,
  farCard,
  farSendResult,
  farTask,
  getTaskParams,
  idOf,
  jsonRpcInterface,
  parseRequest,
  rpcError,
  rpcResult,
  sendMessageParams,
  stateOf,
  taskView,
  textOfParts,
  versionOk,
  wantsPush,
} from "./protocol.ts";

const message = (over: Record<string, unknown> = {}) => ({
  messageId: "m1", role: "ROLE_USER", parts: [{ text: "hello" }], ...over,
});

describe("JSON-RPC envelope", () => {
  it("accepts a request with a string or number id and unknown fields", () => {
    expect(parseRequest({ jsonrpc: "2.0", id: "a", method: "GetTask", params: {}, extra: 1 }).ok).toBe(true);
    expect(parseRequest({ jsonrpc: "2.0", id: 7, method: "GetTask" }).ok).toBe(true);
  });

  it("refuses a batch with -32600 and a null id", () => {
    const result = parseRequest([{ jsonrpc: "2.0", id: 1, method: "GetTask" }]);
    expect(result).toMatchObject({ ok: false, error: { id: null, error: { code: ERR.INVALID_REQUEST } } });
  });

  it("refuses a wrong version, a missing method and an object id, and keeps a usable id", () => {
    for (const body of [
      { jsonrpc: "1.0", id: 1, method: "x" },
      { jsonrpc: "2.0", id: 1 },
      { jsonrpc: "2.0", id: {}, method: "x" },
      { jsonrpc: "2.0", method: "x" },
      "text",
      null,
    ]) expect(parseRequest(body).ok).toBe(false);
    expect(parseRequest({ jsonrpc: "1.0", id: 9, method: "x" })).toMatchObject({ error: { id: 9 } });
    expect(idOf({ id: {} })).toBeNull();
    expect(idOf(5)).toBeNull();
  });

  it("bounds the method name", () => {
    expect(parseRequest({ jsonrpc: "2.0", id: 1, method: "x".repeat(101) }).ok).toBe(false);
  });
});

describe("error and result builders", () => {
  it("builds the standard codes with the spec messages and no detail", () => {
    for (const code of [ERR.PARSE, ERR.INVALID_REQUEST, ERR.METHOD_NOT_FOUND, ERR.INVALID_PARAMS, ERR.INTERNAL]) {
      const body = rpcError(1, code);
      expect(body.error.code).toBe(code);
      expect(body.error.message.length).toBeGreaterThan(0);
      expect(body.error.data).toBeUndefined();
    }
  });

  it("builds every A2A code with an ErrorInfo detail", () => {
    const codes = [ERR.TASK_NOT_FOUND, ERR.TASK_NOT_CANCELABLE, ERR.PUSH_NOT_SUPPORTED, ERR.UNSUPPORTED_OPERATION,
      ERR.CONTENT_TYPE_NOT_SUPPORTED, ERR.VERSION_NOT_SUPPORTED];
    expect(codes).toEqual([-32001, -32002, -32003, -32004, -32005, -32009]);
    for (const code of codes) {
      const body = rpcError("x", code);
      expect(body).toMatchObject({ jsonrpc: "2.0", id: "x", error: { code } });
      expect(body.error.data?.[0]).toMatchObject({ "@type": "type.googleapis.com/google.rpc.ErrorInfo", domain: "a2a-protocol.org" });
      expect(body.error.data?.[0]?.reason).toMatch(/^[A-Z_]+$/u);
    }
    expect(rpcError(1, ERR.TASK_NOT_FOUND).error.data?.[0]?.reason).toBe("TASK_NOT_FOUND");
  });

  it("takes a custom message and wraps a result", () => {
    expect(rpcError(null, ERR.INTERNAL, "boom").error.message).toBe("boom");
    expect(rpcResult(3, { task: 1 })).toEqual({ jsonrpc: "2.0", id: 3, result: { task: 1 } });
  });
});

describe("SendMessage params", () => {
  it("accepts a text message, drops unknown fields and reads an empty context as absent", () => {
    const parsed = sendMessageParams.parse({ message: message({ contextId: "", taskId: "", metadata: { a: 1 }, extra: true }), metadata: {} });
    expect(parsed.message.contextId).toBeUndefined();
    expect(parsed.message.taskId).toBeUndefined();
    expect(parsed.message).not.toHaveProperty("extra");
  });

  it("refuses missing or oversized fields", () => {
    expect(sendMessageParams.safeParse({}).success).toBe(false);
    expect(sendMessageParams.safeParse({ message: message({ messageId: "" }) }).success).toBe(false);
    expect(sendMessageParams.safeParse({ message: message({ messageId: "x".repeat(201) }) }).success).toBe(false);
    expect(sendMessageParams.safeParse({ message: message({ parts: [] }) }).success).toBe(false);
    expect(sendMessageParams.safeParse({ message: message({ parts: Array.from({ length: 21 }, () => ({ text: "a" })) }) }).success).toBe(false);
    expect(sendMessageParams.safeParse({ message: message({ role: "ROLE_SYSTEM" }) }).success).toBe(false);
    expect(sendMessageParams.safeParse({ message: message({ contextId: "c".repeat(257) }) }).success).toBe(false);
    expect(sendMessageParams.safeParse({ message: message({ parts: [{ text: "a".repeat(TEXT_MAX + 1) }] }) }).success).toBe(false);
    expect(sendMessageParams.safeParse({ message: message({ parts: [{ text: 5 }] }) }).success).toBe(false);
  });

  it("checks the configuration", () => {
    expect(sendMessageParams.safeParse({ message: message(), configuration: { returnImmediately: true, historyLength: 0 } }).success).toBe(true);
    expect(sendMessageParams.safeParse({ message: message(), configuration: { returnImmediately: "yes" } }).success).toBe(false);
    expect(sendMessageParams.safeParse({ message: message(), configuration: { historyLength: 101 } }).success).toBe(false);
  });

  it("detects a push configuration under both field names", () => {
    const params = (configuration: Record<string, unknown>) => sendMessageParams.parse({ message: message(), configuration });
    expect(wantsPush(params({}))).toBe(false);
    expect(wantsPush(params({ taskPushNotificationConfig: { url: "https://x" } }))).toBe(true);
    expect(wantsPush(params({ pushNotificationConfig: { url: "https://x" } }))).toBe(true);
    expect(wantsPush(sendMessageParams.parse({ message: message() }))).toBe(false);
  });
});

describe("text of parts", () => {
  const parts = (...list: Record<string, unknown>[]) => sendMessageParams.parse({ message: message({ parts: list }) }).message.parts;

  it("joins text parts", () => {
    expect(textOfParts(parts({ text: "a" }, { text: "b", mediaType: "text/plain" }))).toEqual({ kind: "text", text: "a\nb" });
  });

  it("marks a file, url, data or empty part as unsupported", () => {
    expect(textOfParts(parts({ raw: "AAAA" }))).toEqual({ kind: "unsupported" });
    expect(textOfParts(parts({ url: "https://x" }))).toEqual({ kind: "unsupported" });
    expect(textOfParts(parts({ data: { a: 1 } }))).toEqual({ kind: "unsupported" });
    expect(textOfParts(parts({ text: "a" }, { url: "https://x" }))).toEqual({ kind: "unsupported" });
    expect(textOfParts(parts({ filename: "a.txt" }))).toEqual({ kind: "unsupported" });
  });

  it("marks joined text over the limit", () => {
    const long = parts({ text: "a".repeat(TEXT_MAX) }, { text: "b" });
    expect(textOfParts(long)).toEqual({ kind: "tooLong" });
  });
});

describe("GetTask and CancelTask params", () => {
  it("needs a bounded id", () => {
    expect(getTaskParams.safeParse({ id: "t", historyLength: 3, extra: 1 }).success).toBe(true);
    expect(getTaskParams.safeParse({ id: "" }).success).toBe(false);
    expect(getTaskParams.safeParse({ id: "x".repeat(257) }).success).toBe(false);
    expect(cancelTaskParams.safeParse({ id: "t" }).success).toBe(true);
    expect(cancelTaskParams.safeParse({}).success).toBe(false);
  });
});

describe("A2A-Version header", () => {
  it("treats an absent or empty header as 1.0 and accepts 1.x", () => {
    for (const header of [undefined, "", " ", "1.0", "1.2", "1", ["1.0"], "1.0, 1.1"]) expect(versionOk(header)).toBe(true);
  });

  it("refuses another major version", () => {
    for (const header of ["0.3", "2.0", "abc", "1.0, 0.3", ["0.3"], "10.0"]) expect(versionOk(header)).toBe(false);
  });
});

describe("state mapping", () => {
  it("maps a result", () => {
    expect(stateOf({ ok: true }, "completed")).toBe("TASK_STATE_COMPLETED");
    expect(stateOf({ ok: false, outcome: "refused" }, undefined)).toBe("TASK_STATE_REJECTED");
    expect(stateOf({ ok: false, outcome: "stopped" }, "running")).toBe("TASK_STATE_CANCELED");
    expect(stateOf({ ok: false }, undefined)).toBe("TASK_STATE_FAILED");
    expect(stateOf({ ok: false, outcome: "other" }, undefined)).toBe("TASK_STATE_FAILED");
  });

  it("maps a hand-off status while no result exists", () => {
    expect(stateOf(null, "queued")).toBe("TASK_STATE_SUBMITTED");
    expect(stateOf(null, undefined)).toBe("TASK_STATE_SUBMITTED");
    for (const status of ["running", "waiting", "resume"] as const) expect(stateOf(null, status)).toBe("TASK_STATE_WORKING");
    expect(stateOf(null, "failed")).toBe("TASK_STATE_FAILED");
    expect(stateOf(null, "cancelled")).toBe("TASK_STATE_CANCELED");
    expect(stateOf(null, "completed")).toBe("TASK_STATE_COMPLETED");
  });
});

describe("task view", () => {
  const base = { id: "t1", contextId: "c1", at: Date.UTC(2026, 10, 23, 1, 2, 3) };

  it("shows a completed task with one text artifact", () => {
    expect(taskView({ ...base, state: "TASK_STATE_COMPLETED", text: "done" })).toEqual({
      id: "t1", contextId: "c1",
      status: { state: "TASK_STATE_COMPLETED", timestamp: "2026-11-23T01:02:03.000Z" },
      artifacts: [{ artifactId: "result", parts: [{ text: "done" }] }],
    });
  });

  it("shows no artifact unless the task completed, and a note only for a failure or refusal", () => {
    expect(taskView({ ...base, state: "TASK_STATE_WORKING", text: "x", note: "n" })).toEqual({
      id: "t1", contextId: "c1", status: { state: "TASK_STATE_WORKING", timestamp: "2026-11-23T01:02:03.000Z" },
    });
    const failed = taskView({ ...base, state: "TASK_STATE_FAILED", text: "secret", note: "It failed." });
    expect(failed.artifacts).toBeUndefined();
    expect(failed.status.message).toEqual({ messageId: "t1:status", role: "ROLE_AGENT", parts: [{ text: "It failed." }] });
    expect(taskView({ ...base, state: "TASK_STATE_CANCELED", note: "n" }).status.message).toBeUndefined();
  });
});

describe("Agent Card", () => {
  const card = agentCard({ bot: { id: "b-1", name: "Helper", description: "Does things" }, endpoint: "https://seira.example/api/a2a/b-1" });

  it("lists one bot, text modes and no optional capability", () => {
    expect(card).toMatchObject({
      name: "Helper", description: "Does things", version: "1",
      supportedInterfaces: [{ url: "https://seira.example/api/a2a/b-1", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
      capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
      defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"],
      skills: [{ id: "b-1", name: "Helper", description: "Does things", tags: [] }],
    });
  });

  it("declares bearer auth with the 1.0 field names", () => {
    expect(card.securitySchemes.bearer.httpAuthSecurityScheme.scheme).toBe("Bearer");
    expect(card.securityRequirements).toEqual([{ schemes: { bearer: { list: [] } } }]);
  });

  it("falls back to the title, then the name, for the description", () => {
    expect(agentCard({ bot: { id: "b", name: "N", title: "T" }, endpoint: "https://x/" }).description).toBe("T");
    expect(agentCard({ bot: { id: "b", name: "N" }, endpoint: "https://x/" }).description).toBe("N");
  });

  it("parses as a far card", () => {
    const parsed = farCard.parse(JSON.parse(JSON.stringify(card)));
    expect(jsonRpcInterface(parsed)?.url).toBe("https://seira.example/api/a2a/b-1");
  });
});

describe("far card", () => {
  const valid = {
    name: "Far", supportedInterfaces: [{ url: "https://far.example/rpc", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    skills: [{ id: "s", name: "Skill" }], future: { field: true },
  };

  it("accepts unknown fields and defaults the optional text", () => {
    const parsed = farCard.parse(valid);
    expect(parsed.description).toBe("");
    expect(parsed.skills[0]?.description).toBe("");
    expect(parsed).not.toHaveProperty("future");
  });

  it("refuses a card with no name, no interface or an oversized url", () => {
    expect(farCard.safeParse({ ...valid, name: "" }).success).toBe(false);
    expect(farCard.safeParse({ ...valid, supportedInterfaces: [] }).success).toBe(false);
    expect(farCard.safeParse({ ...valid, supportedInterfaces: [{ url: "x".repeat(2049), protocolBinding: "JSONRPC", protocolVersion: "1.0" }] }).success).toBe(false);
    expect(farCard.safeParse({ ...valid, skills: Array.from({ length: 101 }, (_, n) => ({ id: `s${n}`, name: "n" })) }).success).toBe(false);
  });

  it("picks a JSON-RPC 1.x interface and ignores others", () => {
    const pick = (list: { protocolBinding: string; protocolVersion: string }[]) => jsonRpcInterface(farCard.parse({
      ...valid, supportedInterfaces: list.map((entry) => ({ url: "https://far.example/x", ...entry })),
    }));
    expect(pick([{ protocolBinding: "GRPC", protocolVersion: "1.0" }])).toBeNull();
    expect(pick([{ protocolBinding: "JSONRPC", protocolVersion: "0.3" }])).toBeNull();
    expect(pick([{ protocolBinding: "GRPC", protocolVersion: "1.0" }, { protocolBinding: "JSONRPC", protocolVersion: "1.1" }])).not.toBeNull();
  });
});

describe("far task and send result", () => {
  const task = { id: "t", contextId: "c", status: { state: "TASK_STATE_WORKING" }, unknown: 1 };

  it("accepts a task with unknown fields", () => {
    const parsed = farTask.parse({ ...task, artifacts: [{ artifactId: "a", parts: [{ text: "x" }], other: 1 }] });
    expect(parsed.status.state).toBe("TASK_STATE_WORKING");
    expect(parsed).not.toHaveProperty("unknown");
  });

  it("refuses an unknown state, an empty id and too many artifacts", () => {
    expect(farTask.safeParse({ ...task, status: { state: "TASK_STATE_NEW" } }).success).toBe(false);
    expect(farTask.safeParse({ ...task, status: { state: "working" } }).success).toBe(false);
    expect(farTask.safeParse({ ...task, id: "" }).success).toBe(false);
    expect(farTask.safeParse({ ...task, artifacts: Array.from({ length: 51 }, () => ({ parts: [] })) }).success).toBe(false);
  });

  it("allows a far text up to the result limit and no more", () => {
    const withText = (length: number) => farTask.safeParse({ ...task, artifacts: [{ parts: [{ text: "a".repeat(length) }] }] }).success;
    expect(withText(200_000)).toBe(true);
    expect(withText(200_001)).toBe(false);
  });

  it("wants exactly one of task or message", () => {
    expect(farSendResult.safeParse({ task }).success).toBe(true);
    expect(farSendResult.safeParse({ message: message({ role: "ROLE_AGENT" }) }).success).toBe(true);
    expect(farSendResult.safeParse({}).success).toBe(false);
    expect(farSendResult.safeParse({ task, message: message() }).success).toBe(false);
  });
});
