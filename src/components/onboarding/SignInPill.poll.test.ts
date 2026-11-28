// @vitest-environment happy-dom
// The pill's status poll: a dead server or network slows the poll and then says so, instead of spinning forever.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({
  responses: [] as Array<{ ok?: boolean; body?: unknown; hang?: boolean; status?: number; message?: string }>,
  store: { refreshInstances: vi.fn(), refreshModels: vi.fn() },
}));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => fixture.store,
    api: vi.fn(async (url: string, init?: { timeoutMs?: number }) => {
      const entry = fixture.responses.shift();
      if (!entry) throw new Error(`unexpected call ${url}`);
      if (entry.hang) {
        return new Promise((_, reject) => {
          setTimeout(() => reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })), init?.timeoutMs ?? 0);
        });
      }
      if (entry.status) throw new original.ApiError(entry.message ?? "gone", entry.status);
      if (!entry.ok) throw new Error("server unreachable");
      return entry.body;
    }),
  };
});
vi.mock("@/lib/app-links", () => ({ openExternalLink: vi.fn(async () => {}) }));
vi.mock("@/lib/product-events", () => ({ engineSignedIn: vi.fn() }));
vi.mock("@/components/ClaudeSignIn", () => ({ claudeSignInLink: () => null }));

import { api } from "@/state/store";
import { useSignInPill } from "./SignInPill";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const instance = {
  instanceId: "kimi-1",
  driverKind: "kimiAgent",
  displayName: "Kimi",
  authentication: { method: "device_code" },
} as never as InstanceInfo;

let root: Root;
let container: HTMLDivElement;
const probe = { pill: undefined as ReturnType<typeof useSignInPill> | undefined };
function Probe({ instance }: { instance: InstanceInfo | undefined }) {
  probe.pill = useSignInPill(instance);
  return createElement("div", null, probe.pill.slot.kind);
}
const render = () => act(async () => root.render(createElement(Probe, { instance })));
const start = () => act(() => probe.pill!.start());
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const calls = () => vi.mocked(api).mock.calls as unknown as string[][];

beforeEach(() => {
  vi.useFakeTimers();
  fixture.responses = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("the sign-in pill's status poll", () => {
  it("keeps a waiting sign-in alive at its own pace while the server answers", async () => {
    fixture.responses = [
      { ok: true, body: { auth: { phase: "waiting", flowId: "f1" } } },
      { ok: true, body: { auth: { phase: "waiting", flowId: "f1" } } },
    ];
    await render();
    await start();
    await advance(0);
    await advance(2_000);
    await advance(2_000);
    expect(calls().filter((c) => c[0].includes("/auth/status")).length).toBe(2);
    expect(probe.pill!.slot.kind).toBe("waiting");
  });

  it("slows down when the server stops answering, and gives up with the pill's own words", async () => {
    fixture.responses = [
      { ok: true, body: { auth: { phase: "waiting", flowId: "f1" } } },
      { ok: false }, { ok: false }, { ok: false },
    ];
    await render();
    await start();
    await advance(0);
    expect(probe.pill!.slot.kind).toBe("waiting");
    await advance(2_000);
    await advance(4_000);
    await advance(8_000);
    const status = calls().filter((c) => c[0].includes("/auth/status")).length;
    expect(status).toBe(3);
    expect(probe.pill!.slot.kind).toBe("start");
    expect(probe.pill!.error).toBe("Lost touch with the server during sign-in. Check the connection and start again.");
    await advance(60_000);
    expect(calls().filter((c) => c[0].includes("/auth/status")).length).toBe(3);
  });

  it("counts a request that never came back as a miss, through its own deadline", async () => {
    fixture.responses = [
      { ok: true, body: { auth: { phase: "waiting", flowId: "f1" } } },
      { hang: true }, { hang: true }, { hang: true },
    ];
    await render();
    await start();
    await advance(0);
    await advance(2_000 + 10_000);
    await advance(4_000 + 10_000);
    await advance(8_000 + 10_000);
    expect(calls().filter((c) => c[0].includes("/auth/status")).length).toBe(3);
    expect(probe.pill!.slot.kind).toBe("start");
    expect(probe.pill!.error).toBe("Lost touch with the server during sign-in. Check the connection and start again.");
  });

  it("says what the server said when the sign-in is really gone, without retrying", async () => {
    fixture.responses = [
      { ok: true, body: { auth: { phase: "waiting", flowId: "f1" } } },
      { status: 404, message: "This sign-in flow is gone." },
    ];
    await render();
    await start();
    await advance(0);
    await advance(2_000);
    expect(probe.pill!.slot.kind).toBe("start");
    expect(probe.pill!.error).toBe("This sign-in flow is gone.");
    expect(calls().filter((c) => c[0].includes("/auth/status")).length).toBe(1);
  });

  it("neither counts nor reschedules a request the cleanup aborted", async () => {
    fixture.responses = [
      { ok: true, body: { auth: { phase: "waiting", flowId: "f1" } } },
      { hang: true },
    ];
    await render();
    await start();
    await advance(0);
    await advance(2_000);
    expect(calls().filter((c) => c[0].includes("/auth/status")).length).toBe(1);
    await act(async () => root.unmount());
    await advance(60_000);
    expect(calls().filter((c) => c[0].includes("/auth/status")).length).toBe(1);
  });

  it("recovers the poll after one miss once the server is back", async () => {
    fixture.responses = [
      { ok: true, body: { auth: { phase: "waiting", flowId: "f1" } } },
      { ok: false },
      { ok: true, body: { auth: { phase: "succeeded", flowId: "f1" } } },
    ];
    await render();
    await start();
    await advance(0);
    await advance(2_000);
    await advance(4_000);
    expect(probe.pill!.slot.kind).toBe("start");
    expect(probe.pill!.error).toBeNull();
  });
});
