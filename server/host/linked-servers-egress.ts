// Where this server may dial for a linked server. Security invariant: only a public internet address, at setup and at
// every later connect. A name is resolved, every answer must be public, and the connection uses only an answer that was
// checked, so a second DNS answer cannot move a saved link to a private address.
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";

import { isPublicDomainAddress } from "../custom-domain.ts";
import { testSwitchOn } from "../test-switches.ts";

/** The address is not one this server may dial. The text is safe to show to the person. */
export class LinkedServerDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkedServerDestinationError";
  }
}

export interface DestinationDeps {
  /** Resolves a host name. Default: the system resolver, all answers. A test stands in for DNS with it. */
  lookup?(host: string): Promise<LookupAddress[]>;
  /** Allow loopback addresses, and plain http to them. Default: SEIRA_TEST_LINKED_LOOPBACK is 1. Tests only. */
  allowLoopback?: boolean;
}

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

const isLoopback = (address: string): boolean => {
  const family = isIP(address);
  return family !== 0 && loopback.check(address, family === 4 ? "ipv4" : "ipv6");
};

/** Tests of two servers on one machine set SEIRA_TEST_LINKED_LOOPBACK=1. No other code path allows a local address.
 * Only a start that the test fixture made accepts it (server/test-switches.ts): a normal start ignores the variable. */
export const loopbackAllowed = (env: NodeJS.ProcessEnv = process.env): boolean => testSwitchOn("SEIRA_TEST_LINKED_LOOPBACK", env);

const bare = (hostname: string): string => hostname.replace(/^\[|\]$/gu, "");

/** Whether an address literal may be dialed. */
export const dialable = (address: string, allowLoopback: boolean): boolean => isPublicDomainAddress(address) || (allowLoopback && isLoopback(address));

const NOT_PUBLIC = "That address is not a public internet address, so it was not used.";

/** The checks that need no DNS: the scheme, a user name or password, and an address literal. A name that means this machine is refused too. */
export function checkOriginText(url: URL, allowLoopback: boolean): void {
  const insecure = new LinkedServerDestinationError("That address is not secure (https), so it was not used.");
  if (url.protocol !== "https:" && !(allowLoopback && url.protocol === "http:")) throw insecure;
  if (url.username || url.password) throw new LinkedServerDestinationError("That address holds a user name or a password, so it was not used.");
  const host = bare(url.hostname).toLowerCase();
  if (!host) throw new LinkedServerDestinationError(NOT_PUBLIC);
  const local = host === "localhost" || host.endsWith(".localhost");
  if (isIP(host)) {
    if (!dialable(host, allowLoopback)) throw new LinkedServerDestinationError(NOT_PUBLIC);
    if (url.protocol === "http:" && !isLoopback(host)) throw insecure;
    return;
  }
  if (url.protocol === "http:" && !local) throw insecure;
  if (local && !allowLoopback) throw new LinkedServerDestinationError(NOT_PUBLIC);
}

/** Resolves a host and returns its answers when every one may be dialed. Throws when one may not, or when none came. */
export async function resolveDialable(host: string, deps: DestinationDeps = {}): Promise<LookupAddress[]> {
  const allowLoopback = deps.allowLoopback ?? loopbackAllowed();
  const name = bare(host);
  const family = isIP(name);
  let addresses: LookupAddress[];
  if (family) addresses = [{ address: name, family }];
  else {
    try { addresses = await (deps.lookup ?? ((one: string) => dnsLookup(one, { all: true, verbatim: true })))(name); }
    catch { throw new LinkedServerDestinationError("The address of that server could not be found."); }
  }
  if (addresses.length === 0) throw new LinkedServerDestinationError("The address of that server could not be found.");
  if (!addresses.every((entry) => isIP(entry.address) !== 0 && dialable(entry.address, allowLoopback))) throw new LinkedServerDestinationError(NOT_PUBLIC);
  return addresses;
}

/** Full check of one destination before a request: the text, then every address the name resolves to. */
export async function checkDestination(url: URL, deps: DestinationDeps = {}): Promise<void> {
  const allowLoopback = deps.allowLoopback ?? loopbackAllowed();
  checkOriginText(url, allowLoopback);
  const addresses = await resolveDialable(url.hostname, deps);
  if (url.protocol === "http:" && !addresses.every((entry) => isLoopback(entry.address))) throw new LinkedServerDestinationError("That address is not secure (https), so it was not used.");
}

/** The lookup a new connection uses. It checks the answers it is about to dial, so a name that changed since the check cannot reach a private address. */
export function dialableLookup(deps: DestinationDeps = {}): LookupFunction {
  return ((hostname: string, options: { all?: boolean }, callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void) => {
    resolveDialable(hostname, deps).then((addresses) => {
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    }, (error: unknown) => callback(error instanceof Error ? error : new Error("lookup failed"), ""));
  }) as unknown as LookupFunction;
}

/** A fetch that dials only public addresses. It never follows what a caller refused: redirects stay the caller's choice. */
export function publicFetch(deps: DestinationDeps = {}): typeof fetch {
  let agent: import("undici").Agent | undefined;
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    await checkDestination(url, deps);
    const { Agent, fetch: fetchVia } = await import("undici");
    agent ??= new Agent({ connect: { lookup: dialableLookup(deps) } });
    return await fetchVia(url, { ...init, dispatcher: agent } as Parameters<typeof fetchVia>[1]) as unknown as Response;
  }) as typeof fetch;
}
