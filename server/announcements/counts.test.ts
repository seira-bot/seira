import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_ANNOUNCEMENT_EVENTS_URL } from "../../shared/announcements.ts";
import { AnnouncementCounter, COUNTS_FLUSH_MS, COUNTS_QUEUE_MAX, parseCountEvent } from "./counts.ts";

const SERVED = new Set(["card-one", "card-two"]);
const sent = () => new Response(null, { status: 204 });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function subject(options: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {}) {
  const fetchMock = vi.fn(options.fetch ?? (async () => sent()));
  const counter = new AnnouncementCounter({ fetch: fetchMock as unknown as typeof fetch, env: options.env ?? {}, servedIds: () => SERVED, log: vi.fn() });
  return { counter, fetchMock };
}
const bodyOf = (fetchMock: ReturnType<typeof vi.fn>, call = 0) => JSON.parse(String((fetchMock.mock.calls[call]![1] as RequestInit).body));

describe("announcement counts on the server", () => {
  it("AC-05 sends queued events in one anonymous batch within 60 seconds", async () => {
    const { counter, fetchMock } = subject();
    expect(counter.record({ id: "card-one", action: "shown" })).toBe(true);
    expect(counter.record({ id: "card-two", action: "primary" })).toBe(true);
    await vi.advanceTimersByTimeAsync(COUNTS_FLUSH_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(CLOUD_ANNOUNCEMENT_EVENTS_URL);
    expect(bodyOf(fetchMock)).toEqual({ events: [{ id: "card-one", action: "shown" }, { id: "card-two", action: "primary" }] });
  });

  it("AC-05 sends at once when 50 events are queued", async () => {
    const { counter, fetchMock } = subject();
    for (let i = 0; i < 49; i += 1) counter.record({ id: "card-one", action: "shown" });
    expect(fetchMock).not.toHaveBeenCalled();
    counter.record({ id: "card-two", action: "close" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchMock).events).toHaveLength(50);
  });

  it("AC-05 keeps the timer from holding the process open", () => {
    const unref = vi.fn();
    const real = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const timer = real(fn, ms);
      const wrapped = Object.assign(timer, { unref: () => { unref(); return timer; } });
      return wrapped;
    }) as unknown as typeof setTimeout);
    subject().counter.record({ id: "card-one", action: "shown" });
    expect(unref).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("AC-06 does not queue a card the server does not serve", async () => {
    const { counter, fetchMock } = subject();
    expect(counter.record({ id: "other-card", action: "shown" })).toBe(false);
    await vi.advanceTimersByTimeAsync(COUNTS_FLUSH_MS * 2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("AC-06 refuses a wrong shape", () => {
    for (const body of [null, [], "x", {}, { id: "card-one" }, { action: "shown" }, { id: 4, action: "shown" }, { id: "card-one", action: "bought" }, { id: "x".repeat(41), action: "shown" }]) {
      expect(parseCountEvent(body), JSON.stringify(body)).toBeNull();
    }
    expect(parseCountEvent({ id: "card-one", action: "close", extra: 1 })).toEqual({ id: "card-one", action: "close" });
  });

  it.each([
    ["SEIRA_DISABLE_ANNOUNCEMENTS"],
    ["SEIRA_DISABLE_ANNOUNCEMENT_COUNTS"],
  ])("AC-07 sends nothing when %s=1", async (name) => {
    const { counter, fetchMock } = subject({ env: { [name]: "1" } });
    expect(counter.record({ id: "card-one", action: "shown" })).toBe(false);
    await counter.flush();
    await vi.advanceTimersByTimeAsync(COUNTS_FLUSH_MS * 2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("AC-08 retries a failed batch once on the next send, then drops it", async () => {
    const { counter, fetchMock } = subject({ fetch: async () => { throw new Error("offline"); } });
    counter.record({ id: "card-one", action: "shown" });
    await vi.advanceTimersByTimeAsync(COUNTS_FLUSH_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(COUNTS_FLUSH_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock, 1)).toEqual(bodyOf(fetchMock, 0));
    await vi.advanceTimersByTimeAsync(COUNTS_FLUSH_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("AC-08 treats a 429 or a timeout as a failure and keeps the batch for one retry", async () => {
    let calls = 0;
    const { counter, fetchMock } = subject({ fetch: async (_url, init) => {
      calls += 1;
      if (calls === 1) return new Response(null, { status: 429, headers: { "retry-after": "120" } });
      if (calls === 2) return new Promise<Response>((_resolve, reject) => (init as RequestInit).signal!.addEventListener("abort", () => reject(new Error("aborted"))));
      return sent();
    } });
    counter.record({ id: "card-one", action: "shown" });
    await vi.advanceTimersByTimeAsync(COUNTS_FLUSH_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000 + COUNTS_FLUSH_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("AC-08 keeps at most 200 events", async () => {
    const { counter, fetchMock } = subject({ fetch: async () => { throw new Error("offline"); } });
    for (let i = 0; i < COUNTS_QUEUE_MAX + 100; i += 1) counter.record({ id: "card-one", action: i % 2 ? "shown" : "close" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalled();
    const queued = (counter as unknown as { queue: unknown[] }).queue.length;
    expect(queued).toBeLessThanOrEqual(COUNTS_QUEUE_MAX);
  });

  it("AC-09 sends no cookie, no referrer, no redirect, and only the card id and action", async () => {
    const { counter, fetchMock } = subject();
    counter.record({ id: "card-one", action: "secondary" });
    await counter.flush();
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init).toMatchObject({ method: "POST", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" });
    expect(init.headers).toEqual({ "content-type": "application/json", "user-agent": "Seira" });
    expect(Object.keys(init.headers as object).some((name) => /cookie|authorization|version/i.test(name))).toBe(false);
    expect(JSON.parse(String(init.body))).toEqual({ events: [{ id: "card-one", action: "secondary" }] });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
