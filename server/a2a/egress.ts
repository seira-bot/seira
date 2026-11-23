// Outbound requests to a URL that an admin typed. The host is resolved once, every address must be public, and the
// request dials exactly the address that was checked, so a second DNS answer cannot move it to a private address.
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

import { isPublicDomainAddress } from "../custom-domain.ts";

export type EgressReason = "refused" | "redirect" | "too-large" | "timeout" | "aborted" | "network";

/** `sent` is true once a connection to the far host was open, so the request bytes may have left. A caller may retry only when it is false. */
export class A2aEgressError extends Error {
  readonly reason: EgressReason;
  readonly sent: boolean;

  constructor(reason: EgressReason, message: string, sent: boolean) {
    super(message);
    this.name = "A2aEgressError";
    this.reason = reason;
    this.sent = sent;
  }
}

export interface EgressDeps {
  lookup?(host: string): Promise<LookupAddress[]>;
  /** Allow loopback addresses and plain http to them. Default: the environment variable SEIRA_TEST_A2A_LOOPBACK is 1. */
  allowLoopback?: boolean;
}

export interface EgressOptions {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
}

export interface EgressResult {
  status: number;
  body: string;
  sent: true;
}

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

const isLoopback = (address: string): boolean => {
  const family = isIP(address);
  return family !== 0 && loopback.check(address, family === 4 ? "ipv4" : "ipv6");
};

const allowLoopbackOf = (deps: EgressDeps): boolean => deps.allowLoopback ?? process.env.SEIRA_TEST_A2A_LOOPBACK === "1";

const refused = (message: string) => new A2aEgressError("refused", message, false);

/**
 * Resolves the host once and returns the address to dial. It refuses when the scheme is wrong, the URL holds a
 * credential, or any resolved address is not public.
 */
export async function checkTarget(url: URL, deps: EgressDeps = {}): Promise<LookupAddress> {
  const allowLoopback = allowLoopbackOf(deps);
  if (url.protocol !== "https:" && !(allowLoopback && url.protocol === "http:")) throw refused("The address must use https.");
  if (url.username || url.password) throw refused("The address must not hold a user name or a password.");
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (!host) throw refused("The address has no host.");

  const family = isIP(host);
  let addresses: LookupAddress[];
  if (family) addresses = [{ address: host, family }];
  else {
    try { addresses = await (deps.lookup ?? ((name: string) => dnsLookup(name, { all: true, verbatim: true })))(host); }
    catch { throw refused("The host name could not be resolved."); }
  }
  if (addresses.length === 0) throw refused("The host name could not be resolved.");

  const loopbackOnly = addresses.every((entry) => isLoopback(entry.address));
  for (const entry of addresses) {
    if (isPublicDomainAddress(entry.address) || (allowLoopback && isLoopback(entry.address))) continue;
    throw refused("The address is not a public address.");
  }
  if (url.protocol === "http:" && !loopbackOnly) throw refused("The address must use https.");
  return addresses[0]!;
}

/** One request to a checked address. It follows no redirect, sends no cookie, and stops reading at maxBytes. */
export async function a2aRequest(url: URL, options: EgressOptions, deps: EgressDeps = {}): Promise<EgressResult> {
  if (options.signal?.aborted) throw new A2aEgressError("aborted", "The request was cancelled.", false);
  const address = await checkTarget(url, deps);

  return new Promise<EgressResult>((resolve, reject) => {
    let connected = false;
    let settled = false;
    const fail = (error: A2aEgressError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      request.destroy();
      reject(error);
    };
    const succeed = (result: EgressResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => fail(new A2aEgressError("aborted", "The request was cancelled.", connected));
    const timer = setTimeout(() => fail(new A2aEgressError("timeout", "The request took too long.", connected)), options.timeoutMs);

    const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
      if (lookupOptions.all) callback(null, [address]);
      else callback(null, address.address, address.family);
    };
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (!/^(?:cookie|proxy-authorization|host|content-length)$/iu.test(name)) headers[name] = value;
    }
    if (options.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(options.body));
    headers["User-Agent"] ??= "Seira-a2a";

    const open = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = open(url, { method: options.method, agent: false, lookup, headers }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) { fail(new A2aEgressError("redirect", "The far side answered with a redirect.", true)); return; }
      const declared = Number(response.headers["content-length"]);
      if (Number.isFinite(declared) && declared > options.maxBytes) { fail(new A2aEgressError("too-large", "The answer is too large.", true)); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > options.maxBytes) { fail(new A2aEgressError("too-large", "The answer is too large.", true)); return; }
        chunks.push(chunk);
      });
      response.on("end", () => succeed({ status, body: Buffer.concat(chunks).toString("utf8"), sent: true }));
      response.on("error", () => fail(new A2aEgressError("network", "The connection broke.", true)));
    });
    request.on("socket", (socket) => {
      const mark = () => { connected = true; };
      socket.once(url.protocol === "https:" ? "secureConnect" : "connect", mark);
    });
    request.on("error", () => fail(new A2aEgressError("network", "The far side could not be reached.", connected)));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    request.end(options.body);
  });
}
