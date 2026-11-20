// FR-221: a signed-in machine that gets no seira.run address keeps serving on its other routes.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runLogin, type CliIo, type CliOptions } from "./cli.ts";
import { planTunnel } from "./cli-tunnel-plan.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { startControlPlaneStub, type ControlPlaneStub } from "./testing/control-plane-stub.ts";
import { createTunnelAccount, describeTunnelAccount, openTunnelCredentials, tunnelAccess, tunnelAddressRefusal } from "./tunnel.ts";

const CAPACITY = { status: 503, error: "endpoint_capacity", retryAfterSeconds: 600 };
const LIMIT = { status: 429, error: "endpoint_limit" };
// The texts of electron/companion-account-messages.mjs, pinned here: a change to them is a change to what people read.
const capacityText = "Secure HTTPS links are temporarily full. Try again in 10 minutes, or pair on this Wi-Fi or with Tailscale.";
const limitText = "This account already has the most public addresses it can hold. Release one, then try again.";
const downText = "Secure access is not available right now. Local pairing still works.";

function options(dataDir: string, extra: Partial<CliOptions> = {}): CliOptions {
  return { command: "login", port: 1, dataDir, tailscale: false, tunnel: false, client: false, pair: true, json: false, email: "milind@example.test", ...extra };
}

function fakeIo(answers: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { log: (line) => out.push(line), error: (line) => err.push(line), ask: async () => answers.shift() ?? "" };
  return { io, out, err };
}

describe("no seira.run address this time", () => {
  let dir: string;
  let stub: ControlPlaneStub;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "seira-tunnel-fallback-"));
    stub = await startControlPlaneStub();
    vi.stubEnv("SEIRA_CONTROL_PLANE_URL", stub.url);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await stub.close();
    await removeTempDir(dir);
  });

  const signInWithoutAddress = async () => {
    stub.endpointAnswers.push(CAPACITY);
    const io = fakeIo([stub.otp]);
    expect(await runLogin(options(dir), io.io)).toBe(1);
    return io;
  };
  const plan = async () => {
    const lines: string[] = [];
    const planned = await planTunnel(options(dir, { command: "serve", tunnel: true }), (line) => lines.push(line), { running: () => null });
    return { planned, lines };
  };

  it("login keeps the sign-in, shows why there is no address, and says what serve does next", async () => {
    const { out, err } = await signInWithoutAddress();
    const doc = openTunnelCredentials(dir).read();
    expect(describeTunnelAccount(doc)).toMatchObject({ email: "milind@example.test", address: null });
    expect(tunnelAccess(doc)).toBeNull();
    expect(out).toContain("Signed in as milind@example.test.");
    expect(err.join("\n")).toContain(capacityText);
    expect(out.join("\n")).toMatch(/serve --tunnel asks for one again each time it starts/);
    expect(out.join("\n")).toMatch(/serve --lan.*serve --tailscale/);
  });

  it("login names the account limit when the account already holds its addresses", async () => {
    stub.endpointAnswers.push(LIMIT);
    const io = fakeIo([stub.otp]);
    expect(await runLogin(options(dir), io.io)).toBe(1);
    expect(io.out).toContain("Signed in as milind@example.test.");
    expect(io.err.join("\n")).toContain(limitText);
  });

  it.each([
    ["the tunnel capacity is full (503)", CAPACITY, capacityText],
    ["the account limit is reached (429)", LIMIT, limitText],
  ])("serve plans no tunnel and gives the reason when %s", async (_name, answer, text) => {
    await signInWithoutAddress();
    stub.endpointAnswers.push(answer);
    const { planned, lines } = await plan();
    expect(planned).toEqual({ unavailable: text });
    expect(lines.join("\n")).not.toMatch(/saved address/);
    expect(stub.endpointAnswers).toEqual([]);
  });

  it("serve plans no tunnel when the control plane does not answer", async () => {
    await signInWithoutAddress();
    await stub.close();
    const { planned, lines } = await plan();
    expect(planned).toEqual({ unavailable: downText });
    expect(lines.join("\n")).not.toMatch(/saved address/);
  });

  it("a machine with no account is still a setup error, not a quiet local server", async () => {
    const { planned } = await plan();
    expect(planned).toMatchObject({ error: expect.stringMatching(/login first/) });
  });

  it.each([
    ["503", CAPACITY, "busy", { code: "endpoint_capacity", message: capacityText }],
    ["429", LIMIT, "limit", { code: "endpoint_limit", message: limitText }],
  ])("tunnelAddressRefusal names the refusal after a %s from the control plane", async (_name, answer, problem, refusal) => {
    await signInWithoutAddress();
    stub.endpointAnswers.push(answer);
    const account = createTunnelAccount({ dataDir: dir, version: "test" });
    try {
      const state = await account.service.retry();
      expect(state).toMatchObject({ status: "error", problem });
      expect(tunnelAddressRefusal(state)).toEqual(refusal);
    } finally {
      account.service.dispose();
    }
  });

  it("tunnelAddressRefusal names the refusal when the control plane does not answer", async () => {
    await signInWithoutAddress();
    await stub.close();
    const account = createTunnelAccount({ dataDir: dir, version: "test" });
    try {
      expect(tunnelAddressRefusal(await account.service.retry())).toEqual({ code: "control_plane_unavailable", message: downText });
    } finally {
      account.service.dispose();
    }
  });
});

describe("tunnelAddressRefusal", () => {
  const signedIn = { available: true, email: "milind@example.test" };
  const otherWait = "Secure HTTPS links are temporarily full. Try again in 45 seconds, or pair on this Wi-Fi or with Tailscale. Reference: req-7.";

  it("reads the capacity text with another wait and an error reference", () => {
    expect(tunnelAddressRefusal({ ...signedIn, status: "error", problem: "busy", message: otherWait })).toEqual({ code: "endpoint_capacity", message: otherWait });
  });

  it("gives the control plane text for every unreachable failure", () => {
    const network = "Seira could not reach its secure connection service. Check your internet and try again.";
    expect(tunnelAddressRefusal({ ...signedIn, status: "error", problem: "unreachable", message: network })).toEqual({ code: "control_plane_unavailable", message: downText });
  });

  it.each([
    ["an address is ready", { ...signedIn, status: "ready", endpoint: "https://c-0123.seira.run" }],
    ["the saved address still serves", { ...signedIn, status: "error", problem: "unreachable", endpoint: "https://c-0123.seira.run", message: downText }],
    ["nobody is signed in", { available: false, status: "signed-out", problem: "unreachable", message: downText }],
    ["the service is busy for another reason", { ...signedIn, status: "error", problem: "busy", message: "Too many attempts were made. Wait a little, then try again." }],
    ["the computer limit is reached", { ...signedIn, status: "error", problem: "limit", message: "This account has reached its computer limit. Remove an old computer and try again." }],
    ["the failure is of another kind", { ...signedIn, status: "error", problem: "failed", message: capacityText }],
  ] as const)("is null when %s", (_name, state) => {
    expect(tunnelAddressRefusal(state)).toBeNull();
  });
});
