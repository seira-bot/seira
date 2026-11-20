// Seira's own list for the product-updates question: the address a person gives, and nothing else.
import { SEIRA_HOSTS, seiraOrigin } from "./seira-hosts.mjs";

export const UPDATES_LIST_ORIGIN = seiraOrigin(SEIRA_HOSTS.updates);
const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/;
const RECEIPT = /^[A-Za-z0-9_-]{43}$/;
const MAX_BODY = 64 * 1024;

/** `SEIRA_UPDATES_ORIGIN` is honoured only for a loopback http fixture; any other value falls back to the public list. */
export function updatesListOrigin(env = process.env) {
  const match = typeof env.SEIRA_UPDATES_ORIGIN === "string" ? LOOPBACK.exec(env.SEIRA_UPDATES_ORIGIN) : null;
  return match && Number(match[1]) <= 65535 ? env.SEIRA_UPDATES_ORIGIN : UPDATES_LIST_ORIGIN;
}

export function createUpdatesList({ origin = UPDATES_LIST_ORIGIN, fetcher = fetch } = {}) {
  async function post(body) {
    const response = await fetcher(`${origin}/api/updates-consent`, {
      method: "POST", redirect: "error", credentials: "omit", cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    const reader = response.body?.getReader(), chunks = []; let size = 0;
    try {
      if (reader) while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > MAX_BODY) throw new Error("Updates list response too large.");
        chunks.push(value);
      }
    } catch (error) { await reader?.cancel().catch(() => {}); throw error; }
    finally { reader?.releaseLock(); }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
      if (!response.ok) throw Object.assign(new Error("Updates list request failed."), { status: response.status, opaque: true });
      throw new Error("Invalid updates list response.");
    }
    if (!response.ok) throw Object.assign(new Error("Updates list request failed."), { status: response.status, code: data?.error });
    return data;
  }
  return {
    async updatesConsentByEmail({ email, installId, textVersion }) {
      const result = await post({ status: "opted_in", email, installId, textVersion });
      if (typeof result?.receipt !== "string" || !RECEIPT.test(result.receipt)) throw new Error("Invalid updates list response.");
      return result.receipt;
    },
    async withdrawUpdatesConsent({ status, receipt }) {
      const result = await post({ status, receipt });
      if (result?.ok !== true) throw new Error("Invalid updates list response.");
    },
  };
}

/**
 * Withdraws on the Seira list first. A receipt the list does not know may be one the upstream Admin issued, so the
 * upstream Admin is asked next; only its own unknown_receipt reaches the caller.
 */
export function withUpstreamFallback(list, upstream) {
  return async args => {
    try { return await list.withdrawUpdatesConsent(args); }
    catch (error) {
      if (error?.code !== "unknown_receipt") throw error;
      const client = upstream();
      if (!client) throw new Error("Upstream Admin not available.");
      return client.withdrawUpdatesConsent(args);
    }
  };
}
