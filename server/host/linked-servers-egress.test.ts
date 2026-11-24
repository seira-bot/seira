import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { LinkedServerDestinationError, checkDestination, dialableLookup, publicFetch, resolveDialable } from "./linked-servers-egress.ts";

const answer = (...addresses: string[]) => async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
const refused = (run: () => Promise<unknown>) => run().then(() => "allowed", (error: unknown) => (error instanceof LinkedServerDestinationError ? "refused" : `other: ${String(error)}`));

describe("the public destination of a linked server", () => {
  it("accepts a name whose every answer is a public address", async () => {
    await expect(checkDestination(new URL("https://head.example/x"), { lookup: answer("93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"), allowLoopback: false })).resolves.toBeUndefined();
    await expect(checkDestination(new URL("https://93.184.216.34:8443"), { allowLoopback: false })).resolves.toBeUndefined();
  });

  it.each([
    ["private IPv4 10/8", "https://10.1.2.3"],
    ["private IPv4 172.16/12", "https://172.16.0.1"],
    ["private IPv4 192.168/16", "https://192.168.0.10:8443"],
    ["shared address space", "https://100.64.0.1"],
    ["loopback IPv4", "https://127.0.0.1"],
    ["loopback IPv4 short form", "https://127.1"],
    ["loopback IPv4 as one number", "https://2130706433"],
    ["loopback IPv6", "https://[::1]"],
    ["link-local IPv4 (cloud metadata)", "https://169.254.169.254"],
    ["link-local IPv6", "https://[fe80::1]"],
    ["unique-local IPv6", "https://[fd00::1]"],
    ["IPv4 inside IPv6", "https://[::ffff:10.0.0.1]"],
    ["unspecified address", "https://0.0.0.0"],
    ["localhost", "https://localhost"],
    ["a name under localhost", "https://box.localhost"],
    ["plain http", "http://93.184.216.34"],
    ["a user name", "https://user:pw@head.example"],
  ])("refuses %s", async (_label, url) => {
    expect(await refused(() => checkDestination(new URL(url), { lookup: answer("93.184.216.34"), allowLoopback: false }))).toBe("refused");
  });

  it.each([
    ["private IPv4", ["10.0.0.5"]],
    ["private IPv6", ["fd12:3456::1"]],
    ["loopback", ["127.0.0.1"]],
    ["loopback IPv6", ["::1"]],
    ["link-local", ["169.254.169.254"]],
    ["IPv4 inside IPv6", ["::ffff:192.168.1.1"]],
    ["one private answer among public ones", ["93.184.216.34", "10.0.0.5"]],
    ["no answer", []],
  ])("refuses a name that resolves to %s", async (_label, addresses) => {
    expect(await refused(() => checkDestination(new URL("https://head.example"), { lookup: answer(...addresses), allowLoopback: false }))).toBe("refused");
  });

  it("refuses a name that cannot be resolved", async () => {
    expect(await refused(() => resolveDialable("head.example", { lookup: async () => { throw new Error("ENOTFOUND"); }, allowLoopback: false }))).toBe("refused");
  });

  it("allows loopback, and plain http to it, only when a test asks for it", async () => {
    await expect(checkDestination(new URL("http://127.0.0.1:8123"), { allowLoopback: true })).resolves.toBeUndefined();
    await expect(checkDestination(new URL("http://localhost:8123"), { lookup: answer("127.0.0.1"), allowLoopback: true })).resolves.toBeUndefined();
    expect(await refused(() => checkDestination(new URL("http://127.0.0.1:8123"), { allowLoopback: false }))).toBe("refused");
    expect(await refused(() => checkDestination(new URL("http://10.0.0.5"), { allowLoopback: true }))).toBe("refused");
    expect(await refused(() => checkDestination(new URL("https://192.168.0.5"), { allowLoopback: true }))).toBe("refused");
  });

  it("checks the answer a new connection is about to dial, so a changed DNS answer is refused", async () => {
    let now = ["93.184.216.34"];
    const lookup = dialableLookup({ lookup: async () => now.map((address) => ({ address, family: 4 })), allowLoopback: false });
    const dial = (all: boolean) => new Promise<unknown>((resolve) => { (lookup as unknown as (host: string, options: { all: boolean }, done: (error: Error | null, address: unknown, family?: number) => void) => void)("head.example", { all }, (error, address, family) => resolve({ error: error?.message, address, family })); });
    expect(await dial(false)).toEqual({ address: "93.184.216.34", family: 4 });
    expect(await dial(true)).toEqual({ address: [{ address: "93.184.216.34", family: 4 }] });
    now = ["10.0.0.5"];
    expect(await dial(false)).toMatchObject({ error: expect.stringContaining("not a public internet address") });
    expect(await dial(true)).toMatchObject({ error: expect.stringContaining("not a public internet address") });
  });
});

describe("a fetch that dials only public addresses", () => {
  let server: Server | undefined;
  afterEach(() => { server?.closeAllConnections(); server?.close(); server = undefined; });

  it("sends nothing to a private address, whether it is typed or resolved", async () => {
    let hit = 0;
    server = createServer((_req, res) => { hit += 1; res.end("ok"); });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const ask = publicFetch({ lookup: answer("127.0.0.1"), allowLoopback: false });
    for (const url of [`http://127.0.0.1:${port}/`, `https://127.0.0.1:${port}/`, `https://rebound.example:${port}/`, `http://rebound.example:${port}/`]) {
      await expect(ask(url, { redirect: "error" }), url).rejects.toBeInstanceOf(LinkedServerDestinationError);
    }
    expect(hit).toBe(0);
  });

  it("reaches a loopback server when a test allows it", async () => {
    server = createServer((_req, res) => { res.end("ok"); });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const response = await publicFetch({ allowLoopback: true })(`http://127.0.0.1:${port}/`, { redirect: "error" });
    expect(await response.text()).toBe("ok");
  });
});
