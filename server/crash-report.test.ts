import { afterEach, describe, expect, it, vi } from "vitest";

import { debugIdsByFile } from "../shared/crash-debug-ids.ts";
import { buildCrashReport, CRASH_ACK_WAIT_MS, CRASH_MESSAGE_MAX, CRASH_STACK_MAX, createCrashReporter, crashEngine, type CrashParentPort } from "./crash-report.ts";

type Listener = (event: { data?: unknown }) => void;

function fakePort() {
  const listeners: Listener[] = [];
  const sent: Array<Record<string, unknown>> = [];
  const port: CrashParentPort = { on: (_event, listener) => { listeners.push(listener); }, postMessage: (message) => { sent.push(message as Record<string, unknown>); } };
  return { port, sent, answer: (data: unknown) => listeners.forEach((listener) => listener({ data })) };
}

afterEach(() => { vi.useRealTimers(); });

describe("buildCrashReport", () => {
  it("keeps the error name, the code and the frames, and drops the message lines of the stack", () => {
    const error = Object.assign(new TypeError("canary-message\ncanary-second-line"), { code: "ERR_X" });
    const report = buildCrashReport({ kind: "server-exit", error }, undefined);
    expect(report.kind).toBe("server-exit");
    expect(report.errorName).toBe("TypeError");
    expect(report.errorCode).toBe("ERR_X");
    expect(report.stack).toMatch(/^\s+at /);
    expect(report.stack).not.toContain("canary-second-line");
    expect(report.debugIds).toBeUndefined();
    expect(report.engine).toBeUndefined();
  });

  it("limits the message to 1 KB and the stack to 16 KB", () => {
    const error = new Error("m".repeat(5000));
    error.stack = `Error: x\n${"    at somewhere (file:///a/b.js:1:1)\n".repeat(2000)}`;
    const report = buildCrashReport({ kind: "server-turn", error }, undefined);
    expect(report.message).toHaveLength(CRASH_MESSAGE_MAX);
    expect(report.stack.length).toBeLessThanOrEqual(CRASH_STACK_MAX);
  });

  it("names a thrown value that is not an Error by its type, and never copies a name that is not a plain token", () => {
    expect(buildCrashReport({ kind: "server-exit", error: "plain text" }, undefined).errorName).toBe("string");
    const odd = Object.assign(new Error("x"), { name: "bot /home/someone/secret" });
    expect(buildCrashReport({ kind: "server-exit", error: odd }, undefined).errorName).toBe("object");
  });

  it("reports an engine from the fixed list, and any other engine as custom", () => {
    expect(crashEngine("codex")).toBe("codex");
    expect(crashEngine("claudeAgent")).toBe("claudeAgent");
    expect(crashEngine("my-private-engine")).toBe("custom");
    expect(crashEngine(undefined)).toBeUndefined();
    expect(buildCrashReport({ kind: "server-turn", error: new Error("x"), engine: "bot-name" }, undefined).engine).toBe("custom");
  });

  it("names the bundle files of the debug-id table", () => {
    const table = { "Error\n    at e (file:///opt/seira/dist-server/index.mjs:2:3)": "123e4567-e89b-12d3-a456-426614174000" };
    expect(buildCrashReport({ kind: "server-exit", error: new Error("x") }, table).debugIds).toEqual({ "/opt/seira/dist-server/index.mjs": "123e4567-e89b-12d3-a456-426614174000" });
    expect(debugIdsByFile({ "x": "not-an-id" })).toBeUndefined();
    expect(debugIdsByFile(undefined)).toBeUndefined();
  });
});

describe("createCrashReporter", () => {
  it("does nothing without a parent port, so a server without the desktop sends nothing", async () => {
    const report = createCrashReporter({ port: () => undefined });
    await expect(report({ kind: "server-exit", error: new Error("x") })).resolves.toBeUndefined();
  });

  it("posts the report with a request id of 8 to 64 safe characters and resolves on the matching ack", async () => {
    const { port, sent, answer } = fakePort();
    const report = createCrashReporter({ port: () => port });
    let done = false;
    const pending = report({ kind: "server-exit", error: new Error("boom") }).then(() => { done = true; });
    expect(sent).toHaveLength(1);
    const message = sent[0]!;
    expect(message.type).toBe("seira:crash-report");
    expect(String(message.requestId)).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect((message.report as { message: string }).message).toBe("boom");
    answer({ type: "seira:crash-report-ack", requestId: "another-request" });
    await Promise.resolve();
    expect(done).toBe(false);
    answer({ type: "seira:crash-report-ack", requestId: message.requestId });
    await pending;
    expect(done).toBe(true);
  });

  it("stops waiting after 2000 ms when no ack comes", async () => {
    vi.useFakeTimers();
    const { port, sent } = fakePort();
    const report = createCrashReporter({ port: () => port });
    let done = false;
    void report({ kind: "server-turn", error: new Error("x") }).then(() => { done = true; });
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(CRASH_ACK_WAIT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it("resolves at once and does not throw when the port throws", async () => {
    const port: CrashParentPort = { on: () => {}, postMessage: () => { throw new Error("closed"); } };
    await expect(createCrashReporter({ port: () => port })({ kind: "server-exit", error: new Error("x") })).resolves.toBeUndefined();
  });

  it("listens once for acks however many reports it sends", async () => {
    vi.useFakeTimers();
    const on = vi.fn();
    const port: CrashParentPort = { on, postMessage: () => {} };
    const report = createCrashReporter({ port: () => port });
    void report({ kind: "server-turn", error: new Error("a") });
    void report({ kind: "server-turn", error: new Error("b") });
    expect(on).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CRASH_ACK_WAIT_MS);
  });
});
