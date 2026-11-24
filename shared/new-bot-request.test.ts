import { describe, expect, it } from "vitest";

import { createBotOnce, newBotId } from "./new-bot-request.ts";

const OWN_ID = /^[\w-]{8,128}$/;

/** A server that keeps a bot before it answers, and answers 409 for an id it has. */
function server(lose: number) {
  const bots = new Map<string, { id: string; name: unknown }>();
  const bodies: Array<Record<string, unknown>> = [];
  let lost = 0;
  const send = async (body: Record<string, unknown>) => {
    bodies.push(body);
    const id = typeof body.id === "string" ? body.id : `server-${bots.size + 1}-made`;
    if (bots.has(id)) throw Object.assign(new Error("a bot with this id already exists here"), { status: 409 });
    bots.set(id, { id, name: body.name });
    if (lost++ < lose) throw new TypeError("fetch failed");
    return { bot: bots.get(id)! };
  };
  return { bots, bodies, send, find: async (id: string) => (bots.has(id) ? { bot: bots.get(id)! } : null) };
}

const sleeps: number[] = [];
const sleep = async (ms: number) => { sleeps.push(ms); };

describe("making a bot once", () => {
  it("makes ids the server accepts, a new one each time", () => {
    const ids = new Set(Array.from({ length: 50 }, newBotId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(OWN_ID);
  });

  it("makes one bot when the answer is lost and the request is sent again", async () => {
    const fake = server(1);
    const made = await createBotOnce({ name: "x" }, { send: fake.send, find: fake.find, sleep });
    expect(fake.bots.size).toBe(1);
    expect(made.bot.name).toBe("x");
    expect(fake.bodies).toHaveLength(2);
    expect(fake.bodies[1]!.id).toBe(fake.bodies[0]!.id);
    expect(fake.bodies[0]).toMatchObject({ fresh: true });
    expect(fake.bodies[0]!.id).toMatch(OWN_ID);
  });

  it("keeps an id the caller names, and sends no id twice for two bots", async () => {
    const fake = server(0);
    await createBotOnce({ name: "a", id: "caller-chosen-id" }, { send: fake.send, find: fake.find, sleep });
    await createBotOnce({ name: "b" }, { send: fake.send, find: fake.find, sleep });
    expect(fake.bodies.map((body) => body.id)).toContain("caller-chosen-id");
    expect(new Set(fake.bodies.map((body) => body.id)).size).toBe(2);
  });

  it("waits longer before each resend and gives up after the last", async () => {
    sleeps.length = 0;
    const bodies: Array<Record<string, unknown>> = [];
    const send = async (body: Record<string, unknown>) => { bodies.push(body); throw new TypeError("fetch failed"); };
    await expect(createBotOnce({ name: "x" }, { send, find: async () => null, sleep }, [10, 20])).rejects.toBeInstanceOf(TypeError);
    expect(sleeps).toEqual([10, 20]);
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies.map((body) => body.id)).size).toBe(1);
  });

  it("resends after a timeout too", async () => {
    const fake = server(0);
    let first = true;
    const send = async (body: Record<string, unknown>) => {
      if (first) { first = false; await fake.send(body); throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }
      return fake.send(body);
    };
    await createBotOnce({ name: "x" }, { send, find: fake.find, sleep });
    expect(fake.bots.size).toBe(1);
  });

  it("does not resend a refusal, and does not take a 409 on the first send for a lost answer", async () => {
    let sent = 0;
    const refused = Object.assign(new Error("You've reached the 5 bots Starter includes."), { status: 409 });
    const send = async () => { sent += 1; throw refused; };
    const find = async () => { throw new Error("must not look"); };
    await expect(createBotOnce({ name: "x" }, { send, find })).rejects.toBe(refused);
    expect(sent).toBe(1);
  });

  it("gives back the refusal when a 409 on a resend names no bot of ours", async () => {
    let sent = 0;
    const send = async () => { throw sent++ === 0 ? new TypeError("fetch failed") : Object.assign(new Error("full"), { status: 409 }); };
    await expect(createBotOnce({ name: "x" }, { send, find: async () => null, sleep })).rejects.toMatchObject({ status: 409 });
  });
});
