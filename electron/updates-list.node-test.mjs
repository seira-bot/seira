import assert from "node:assert/strict";
import test from "node:test";
import { createUpdatesList, UPDATES_LIST_ORIGIN, updatesListOrigin, withUpstreamFallback } from "./updates-list.mjs";

const RECEIPT = "r".repeat(43);
const reply = (status, data) => async (url, init) => { reply.last = { url, init }; return new Response(typeof data === "string" ? data : JSON.stringify(data), { status }); };

test("opt-in posts the address and returns the receipt", async () => {
  const fetcher = reply(200, { receipt: RECEIPT });
  const list = createUpdatesList({ origin: "http://127.0.0.1:1", fetcher });
  const receipt = await list.updatesConsentByEmail({ email: "a@example.test", installId: "install", textVersion: "2026-10-23" });
  assert.equal(receipt, RECEIPT);
  const { url, init } = reply.last;
  assert.equal(url, "http://127.0.0.1:1/api/updates-consent");
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.equal(init.credentials, "omit");
  assert.equal(init.cache, "no-store");
  assert.deepEqual(JSON.parse(init.body), { status: "opted_in", email: "a@example.test", installId: "install", textVersion: "2026-10-23" });
});

test("a receipt of the wrong shape throws", async () => {
  for (const receipt of ["short", 5, undefined, `${"r".repeat(42)}!`]) {
    const list = createUpdatesList({ fetcher: reply(200, { receipt }) });
    await assert.rejects(list.updatesConsentByEmail({ email: "a@example.test", installId: "i", textVersion: "v" }), /Invalid updates list response/);
  }
});

test("withdrawal posts the receipt and needs ok:true", async () => {
  const list = createUpdatesList({ fetcher: reply(200, { ok: true }) });
  await list.withdrawUpdatesConsent({ status: "withdrawn", receipt: RECEIPT });
  assert.deepEqual(JSON.parse(reply.last.init.body), { status: "withdrawn", receipt: RECEIPT });
  await assert.rejects(createUpdatesList({ fetcher: reply(200, { ok: false }) }).withdrawUpdatesConsent({ status: "declined", receipt: RECEIPT }), /Invalid updates list response/);
});

test("an error carries the HTTP status and the code from the body", async () => {
  const list = createUpdatesList({ fetcher: reply(404, { error: "unknown_receipt" }) });
  await assert.rejects(list.withdrawUpdatesConsent({ status: "withdrawn", receipt: RECEIPT }), error => error.status === 404 && error.code === "unknown_receipt");
  await assert.rejects(createUpdatesList({ fetcher: reply(429, { error: "rate_limited" }) }).updatesConsentByEmail({ email: "a@example.test", installId: "i", textVersion: "v" }),
    error => error.status === 429 && error.code === "rate_limited");
  await assert.rejects(createUpdatesList({ fetcher: reply(502, "<html>") }).withdrawUpdatesConsent({ status: "withdrawn", receipt: RECEIPT }), error => error.status === 502 && error.opaque === true);
});

test("a response over 64 KB is refused", async () => {
  const list = createUpdatesList({ fetcher: reply(200, JSON.stringify({ receipt: RECEIPT, pad: "x".repeat(70_000) })) });
  await assert.rejects(list.updatesConsentByEmail({ email: "a@example.test", installId: "i", textVersion: "v" }), /too large/);
});

test("the origin is the public list unless a loopback http fixture is named", () => {
  assert.equal(UPDATES_LIST_ORIGIN, "https://updates.seira.bot");
  assert.equal(updatesListOrigin({}), UPDATES_LIST_ORIGIN);
  assert.equal(updatesListOrigin({ OMB_UPDATES_ORIGIN: "http://127.0.0.1:18801" }), "http://127.0.0.1:18801");
  assert.equal(updatesListOrigin({ OMB_UPDATES_ORIGIN: "http://[::1]:18801" }), "http://[::1]:18801");
  for (const value of ["https://127.0.0.1:18801", "http://localhost:18801", "http://127.0.0.1", "http://127.0.0.1:18801/", "http://127.0.0.1:99999",
    "http://example.test:80", "http://127.0.0.1:18801@example.test", "https://evil.example"]) {
    assert.equal(updatesListOrigin({ OMB_UPDATES_ORIGIN: value }), UPDATES_LIST_ORIGIN, value);
  }
});

test("withUpstreamFallback: the Seira list answers, so the upstream Admin is not asked", async () => {
  const calls = [];
  const withdraw = withUpstreamFallback({ withdrawUpdatesConsent: async args => { calls.push(["list", args]); } },
    () => ({ withdrawUpdatesConsent: async args => { calls.push(["upstream", args]); } }));
  await withdraw({ status: "withdrawn", receipt: RECEIPT });
  assert.deepEqual(calls.map(call => call[0]), ["list"]);
});

test("withUpstreamFallback: an unknown receipt on the list is withdrawn upstream with the same arguments", async () => {
  const calls = [], unknown = () => Object.assign(new Error("x"), { code: "unknown_receipt" });
  const withdraw = withUpstreamFallback({ withdrawUpdatesConsent: async () => { throw unknown(); } },
    () => ({ withdrawUpdatesConsent: async args => { calls.push(args); } }));
  await withdraw({ status: "declined", receipt: RECEIPT });
  assert.deepEqual(calls, [{ status: "declined", receipt: RECEIPT }]);
});

test("withUpstreamFallback: both unknown throws unknown_receipt; an upstream network error throws", async () => {
  const unknown = () => Object.assign(new Error("x"), { code: "unknown_receipt" });
  const list = { withdrawUpdatesConsent: async () => { throw unknown(); } };
  await assert.rejects(withUpstreamFallback(list, () => ({ withdrawUpdatesConsent: async () => { throw unknown(); } }))({ status: "withdrawn", receipt: RECEIPT }),
    error => error.code === "unknown_receipt");
  await assert.rejects(withUpstreamFallback(list, () => ({ withdrawUpdatesConsent: async () => { throw new Error("offline"); } }))({ status: "withdrawn", receipt: RECEIPT }),
    error => error.message === "offline" && error.code !== "unknown_receipt");
  await assert.rejects(withUpstreamFallback({ withdrawUpdatesConsent: async () => { throw Object.assign(new Error("x"), { code: "rate_limited" }); } },
    () => { throw new Error("must not be asked"); })({ status: "withdrawn", receipt: RECEIPT }), error => error.code === "rate_limited");
});
