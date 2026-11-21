import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createContainerTunnel, type ContainerTunnelDeps } from "./container-tunnel.ts";
import { superviseServer } from "./server-launcher.ts";

const ENDPOINT = "https://c-abc123.seira.run";

function harness(options: { plans?: unknown[]; up?: () => boolean } = {}) {
  const events: string[] = [];
  const logs: string[] = [];
  const started: Array<{ originTarget: { pid: number; socketPath: string }; env?: NodeJS.ProcessEnv }> = [];
  let planned = 0;
  let serial = 0;
  const deps: Partial<ContainerTunnelDeps> = {
    plan: (async () => {
      const next = options.plans?.[planned++] ?? "ok";
      events.push("plan");
      if (next !== "ok") return next;
      const id = ++serial;
      return { access: { endpoint: ENDPOINT, token: "secret-token" }, binary: "/usr/local/bin/cloudflared", guardian: "/guardian.mjs", origin: { socketPath: `/run/origin-${id}.sock` }, account: null };
    }) as unknown as ContainerTunnelDeps["plan"],
    start: ((start: { originTarget: { pid: number; socketPath: string }; env?: NodeJS.ProcessEnv }) => {
      events.push(`start pid=${start.originTarget.pid} socket=${start.originTarget.socketPath}`);
      started.push(start);
      return {
        address: ENDPOINT,
        state: () => ({ status: "ready", ready: true }),
        started: Promise.resolve({ status: "ready", ready: true }),
        restart: async () => ({ status: "ready", ready: true }),
        stop: async () => { events.push("stop"); },
      };
    }) as unknown as ContainerTunnelDeps["start"],
    cleanup: ((origin: { socketPath: string }) => { events.push(`cleanup ${origin.socketPath}`); }) as unknown as ContainerTunnelDeps["cleanup"],
    serverUp: async () => options.up?.() ?? true,
    sleep: async () => undefined,
  };
  const tunnel = createContainerTunnel({ dataDir: "/data", port: 8799, env: { PATH: "/bin", HOME: "/data", OPENAI_API_KEY: "sk-secret" }, log: (line) => logs.push(line), deps });
  return { tunnel, events, logs, started };
}

describe("container tunnel", () => {
  it("gives the server the account address and connects the tunnel to it once it answers", async () => {
    const { tunnel, events, started } = harness();
    const env = await tunnel.prepare();
    expect(env).toEqual({ SEIRA_PUBLIC_URL: ENDPOINT, SEIRA_TUNNEL_SOCKET: "/run/origin-1.sock", SEIRA_SERVES_TUNNEL: "1" });
    await tunnel.attach(42);
    expect(events).toEqual(["plan", "start pid=42 socket=/run/origin-1.sock"]);
    expect(Object.keys(started[0]!.env ?? {}).sort()).toEqual(["HOME", "PATH"]);
  });

  it("does not connect while the server does not answer, and not after it was released", async () => {
    let up = false;
    const { tunnel, events } = harness({ up: () => up });
    await tunnel.prepare();
    const attached = tunnel.attach(7);
    await tunnel.release();
    up = true;
    await attached;
    expect(events.some((event) => event.startsWith("start"))).toBe(false);
  });

  it("keeps waiting for a server that answers after more than a minute", async () => {
    let polls = 0;
    const { tunnel, events } = harness({ up: () => ++polls > 300 });
    await tunnel.prepare();
    await tunnel.attach(9);
    expect(polls).toBe(301);
    expect(events.filter((event) => event.startsWith("start"))).toEqual(["start pid=9 socket=/run/origin-1.sock"]);
  });

  it("releases a prepared plan when a stop signal arrives while the plan is made", async () => {
    const { tunnel, events } = harness();
    let open!: () => void;
    const gate = new Promise<void>((resume) => { open = resume; });
    const signals = new EventEmitter();
    let spawns = 0;
    const done = superviseServer(() => { spawns += 1; return new EventEmitter() as unknown as ChildProcess; }, {
      signals: signals as never,
      prepare: async () => { await gate; await tunnel.prepare(); },
      spawned: () => undefined,
      release: () => tunnel.release(),
    });
    signals.emit("SIGTERM");
    open();
    expect(await done).toBe(0);
    expect(spawns).toBe(0);
    expect(events).toEqual(["plan", "cleanup /run/origin-1.sock"]);
  });

  it("starts the server without the tunnel, with one log line, when the account gets no address", async () => {
    const { tunnel, events, logs } = harness({ plans: [{ unavailable: "capacity" }] });
    expect(await tunnel.prepare()).toEqual({});
    await tunnel.attach(42);
    expect(events).toEqual(["plan"]);
    expect(logs).toEqual(["tunnel: capacity. This server starts without a public address."]);
  });

  it("stops the old connector and removes its origin before it plans and starts the next, and never runs two", async () => {
    const { tunnel, events } = harness();
    await tunnel.prepare();
    await tunnel.attach(42);
    await tunnel.release();
    await tunnel.prepare();
    await tunnel.attach(43);
    expect(events).toEqual(["plan", "start pid=42 socket=/run/origin-1.sock", "stop", "cleanup /run/origin-1.sock", "plan", "start pid=43 socket=/run/origin-2.sock"]);
  });

  it("connects the tunnel to the new server after the supervisor restarts it in place", async () => {
    const { tunnel, events } = harness();
    const children: ChildProcess[] = [];
    let pid = 100;
    const start = () => {
      const child = Object.assign(new EventEmitter(), { pid: ++pid, kill: () => true }) as unknown as ChildProcess;
      children.push(child);
      return child;
    };
    let env: Record<string, string> = {};
    const done = superviseServer(start, {
      signals: new EventEmitter() as never,
      now: () => 0,
      prepare: async () => { env = await tunnel.prepare(); },
      spawned: (child) => { void tunnel.attach(child.pid!); },
      release: () => tunnel.release(),
    });
    await new Promise((resume) => setTimeout(resume, 10));
    expect(env.SEIRA_PUBLIC_URL).toBe(ENDPOINT);
    children[0]!.emit("exit", 75, null);
    await new Promise((resume) => setTimeout(resume, 30));
    expect(events.filter((event) => event.startsWith("start"))).toEqual(["start pid=101 socket=/run/origin-1.sock", "start pid=102 socket=/run/origin-2.sock"]);
    expect(events.indexOf("stop")).toBeLessThan(events.lastIndexOf("plan"));
    children[1]!.emit("exit", 0, null);
    await done;
  });

  it("never logs a pairing link", async () => {
    const { tunnel, logs } = harness({ plans: ["ok", { error: "no account" }] });
    await tunnel.prepare();
    await tunnel.attach(1);
    await tunnel.release();
    await tunnel.prepare();
    expect(logs.join("\n")).not.toContain("/pair#code=");
  });
});
