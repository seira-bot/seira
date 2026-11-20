// FR-221: a signed-in machine that gets no seira.run address keeps serving on its other routes.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { planTunnel, runLogin, type CliIo, type CliOptions } from "./cli.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { startControlPlaneStub, type ControlPlaneStub } from "./testing/control-plane-stub.ts";
import { describeTunnelAccount, openTunnelCredentials, tunnelAccess } from "./tunnel.ts";

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
});
