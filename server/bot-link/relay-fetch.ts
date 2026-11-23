// A `fetch` whose every call runs over one new stream of an open Seira Relay session. The link dialer takes it in place
// of the global `fetch`, so a link whose far side has no address of its own needs no other change.
import { request, type IncomingMessage } from "node:http";
import { pipeline, Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import type { E2ESession } from "../../companion/src/e2e/session.ts";

const BODYLESS = new Set([204, 205, 304]);
const noop = (): void => {};

/** Only the path and the query of the address are sent; its host is never looked up or dialed. Supports `method`, `headers`,
 * a string or `Blob` body, `signal`, and `redirect` (an answer that redirects rejects, as `redirect: "error"` does). Every
 * call opens its own stream and closes it with the answer, and an abort or a closed session rejects the call. */
export function fetchOverSession(session: () => Promise<E2ESession<never>>): typeof fetch {
  return async (input, init = {}) => {
    if (typeof input !== "string" && !(input instanceof URL)) throw new TypeError("a relay fetch takes an address, not a Request");
    const url = new URL(input);
    const body = init.body ?? undefined;
    if (body !== undefined && typeof body !== "string" && !(body instanceof Blob)) throw new TypeError("a relay fetch sends a string or a Blob");
    const signal = init.signal ?? undefined;
    signal?.throwIfAborted();
    const stream = (await session()).openStream();
    const method = (init.method ?? "GET").toUpperCase();

    return new Promise<Response>((resolve, reject) => {
      const headers: Record<string, string> = { ...Object.fromEntries(new Headers(init.headers)), host: url.host, connection: "close" };
      if (typeof body === "string") headers["content-length"] = String(Buffer.byteLength(body));
      else if (body) headers["content-length"] = String(body.size);
      const req = request({ method, path: `${url.pathname}${url.search}`, headers, agent: false, createConnection: () => stream });

      const onAbort = (): void => {
        const reason: unknown = signal?.reason;
        req.destroy(reason instanceof Error ? reason : new Error("aborted"));
        reject(reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const finish = (): void => {
        signal?.removeEventListener("abort", onAbort);
        stream.destroy();
      };

      req.on("error", (error) => reject(error));
      req.once("close", finish);
      req.on("response", (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        res.on("error", noop);
        if (status >= 300 && status < 400 && status !== 304 && init.redirect !== "manual") {
          res.resume();
          req.destroy();
          return reject(new TypeError(`the other side answered with a redirect (${status})`));
        }
        const answerHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) answerHeaders.append(name, one);
        }
        const empty = BODYLESS.has(status) || method === "HEAD";
        if (empty) res.resume();
        resolve(new Response(empty ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>), { status, statusText: res.statusMessage, headers: answerHeaders }));
      });

      if (body instanceof Blob) pipeline(Readable.fromWeb(body.stream() as unknown as NodeReadableStream), req, noop);
      else req.end(body);
    });
  };
}
