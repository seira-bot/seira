import { describe, expect, it } from "vitest";

import { createBotOnce, newRetryKey } from "./new-bot-request.ts";

const sleep = async () => {};

describe("newRetryKey", () => {
  it("is in the form the server accepts and differs each time", () => {
    const keys = new Set(Array.from({ length: 50 }, newRetryKey));
    expect(keys.size).toBe(50);
    for (const key of keys) expect(key).toMatch(/^[\w-]{16,128}$/);
  });
});

describe("createBotOnce", () => {
  it("sends one retry key and no id", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const made = await createBotOnce({ name: "x" }, async (body) => { bodies.push(body); return { bot: "ok" }; }, undefined, sleep);
    expect(made).toEqual({ bot: "ok" });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ name: "x", retryKey: expect.stringMatching(/^[\w-]{16,128}$/) });
    expect(bodies[0]).not.toHaveProperty("id");
  });

  it("sends the same request with the same key again after no answer came, then returns the answer", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const waits: number[] = [];
    const made = await createBotOnce({ name: "x" }, async (body) => {
      bodies.push(body);
      if (bodies.length < 3) throw new TypeError("fetch failed");
      return "answer";
    }, [10, 20], async (ms) => { waits.push(ms); });
    expect(made).toBe("answer");
    expect(waits).toEqual([10, 20]);
    expect(new Set(bodies.map((body) => body.retryKey)).size).toBe(1);
  });

  it("treats a timeout as no answer", async () => {
    let calls = 0;
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    await createBotOnce({ name: "x" }, async () => { calls += 1; if (calls === 1) throw timeout; return 1; }, [1], sleep);
    expect(calls).toBe(2);
  });

  it("gives up with the last error after the waits are used", async () => {
    let calls = 0;
    await expect(createBotOnce({ name: "x" }, async () => { calls += 1; throw new TypeError("down"); }, [1, 2], sleep)).rejects.toBeInstanceOf(TypeError);
    expect(calls).toBe(3);
  });

  it("does not send again when the server answered with a refusal", async () => {
    let calls = 0;
    const refused = Object.assign(new Error("full"), { status: 403 });
    await expect(createBotOnce({ name: "x" }, async () => { calls += 1; throw refused; }, [1, 2], sleep)).rejects.toBe(refused);
    expect(calls).toBe(1);
  });

  it("makes a new key for each creation", async () => {
    const keys: unknown[] = [];
    for (let index = 0; index < 2; index += 1) await createBotOnce({ name: "x" }, async (body) => { keys.push(body.retryKey); return 1; }, undefined, sleep);
    expect(keys[0]).not.toBe(keys[1]);
  });
});
