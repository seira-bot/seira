import { describe, expect, it } from "vitest";

import { sha256 } from "./common";
import { updatesHarness } from "./test-harness";

const RECEIPT = /^[A-Za-z0-9_-]{43}$/;

describe("opt-in", () => {
  it("returns a 43-character receipt and sends one confirmation email (AC-02)", async () => {
    const h = updatesHarness();
    const { response, body } = await h.optIn("  Ana@Example.Test ");
    expect(response.status).toBe(200);
    expect(body.receipt).toMatch(RECEIPT);
    expect(h.emails).toHaveLength(1);
    const [mail] = h.emails;
    expect(mail!.to).toBe("ana@example.test");
    expect(mail!.subject).toBe("Confirm your Seira updates");
    expect(mail!.from).toEqual({ email: "updates@site.test", name: "Seira" });
    expect(mail!.text).toContain("https://updates.test/confirm?t=");
    expect(mail!.html).toContain("https://updates.test/confirm?t=");
    expect(mail!.headers).toBeUndefined();
    expect(h.subscriber("ana@example.test")?.status).toBe("pending");
    const stored = h.receipts("ana@example.test");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.receipt_hash).not.toBe(body.receipt);
    expect(h.subscriber("ana@example.test")?.confirm_hash).not.toContain(h.confirmToken());
  });

  it("sends no second email within 10 minutes, and one again after (AC-07)", async () => {
    const h = updatesHarness();
    const first = await h.optIn("ana@example.test");
    const second = await h.optIn("ana@example.test");
    expect(second.response.status).toBe(200);
    expect(second.body.receipt).toMatch(RECEIPT);
    expect(second.body.receipt).not.toBe(first.body.receipt);
    expect(h.emails).toHaveLength(1);
    expect(h.receipts("ana@example.test")).toHaveLength(2);

    h.d1.db.exec("UPDATE subscribers SET confirm_sent_at = confirm_sent_at - 601");
    await h.optIn("ana@example.test");
    expect(h.emails).toHaveLength(2);
  });

  it("sends no email for a confirmed address and answers the same way", async () => {
    const h = updatesHarness();
    await h.confirmed("ana@example.test");
    const before = h.emails.length;
    const { response, body } = await h.optIn("ana@example.test");
    expect(response.status).toBe(200);
    expect(Object.keys(body)).toEqual(["receipt"]);
    expect(h.emails).toHaveLength(before);
    expect(h.subscriber("ana@example.test")?.status).toBe("confirmed");
  });

  it("puts an unsubscribed address back to pending with a new email", async () => {
    const h = updatesHarness();
    const { body } = await h.optIn("ana@example.test");
    await h.consent({ status: "withdrawn", receipt: body.receipt });
    h.d1.db.exec("UPDATE subscribers SET confirm_sent_at = confirm_sent_at - 601");
    await h.optIn("ana@example.test");
    expect(h.subscriber("ana@example.test")?.status).toBe("pending");
    expect(h.subscriber("ana@example.test")?.unsubscribed_at).toBeNull();
    expect(h.emails).toHaveLength(2);
  });

  it("keeps the first link valid when a person withdraws and opts in again inside 10 minutes", async () => {
    const h = updatesHarness();
    const first = await h.optIn("ana@example.test");
    const token = h.confirmToken();
    await h.consent({ status: "withdrawn", receipt: first.body.receipt });
    expect(h.subscriber("ana@example.test")?.confirm_hash).not.toBeNull();
    await h.optIn("ana@example.test");
    expect(h.emails).toHaveLength(1);
    expect(h.subscriber("ana@example.test")?.status).toBe("pending");
    expect((await h.postForm("/confirm", { t: token })).status).toBe(200);
    expect(h.subscriber("ana@example.test")?.status).toBe("confirmed");
  });

  it("sends one new email when a confirmed person withdraws and opts in again", async () => {
    const h = updatesHarness();
    const { body } = await h.optIn("ana@example.test");
    await h.postForm("/confirm", { t: h.confirmToken() });
    await h.consent({ status: "withdrawn", receipt: body.receipt });
    expect(h.subscriber("ana@example.test")?.status).toBe("unsubscribed");
    expect(h.emails).toHaveLength(1);
    await h.optIn("ana@example.test");
    expect(h.emails).toHaveLength(2);
    await h.optIn("ana@example.test");
    expect(h.emails).toHaveLength(2);
    expect(h.subscriber("ana@example.test")?.status).toBe("pending");
  });

  it("answers 502 and keeps no receipt when the email send fails", async () => {
    const h = updatesHarness();
    h.mail.failWhen = () => "E_RATE_LIMIT_EXCEEDED";
    const { response, body } = await h.optIn("ana@example.test");
    expect(response.status).toBe(502);
    expect(body).toEqual({ error: "send_failed" });
    expect(h.d1.rows("SELECT * FROM receipts")).toHaveLength(0);
    expect(h.d1.rows("SELECT * FROM subscribers")).toHaveLength(0);
  });

  it.each([
    ["no at sign", { email: "ana.example.test" }],
    ["two at signs", { email: "a@b@example.test" }],
    ["no dot in the domain", { email: "ana@localhost" }],
    ["a space inside", { email: "an a@example.test" }],
    ["a control character", { email: "ana\u0007@example.test" }],
    ["too long", { email: `${"a".repeat(250)}@example.test` }],
    ["not a string", { email: 42 }],
    ["a bad text version", { textVersion: "V 1" }],
    ["a missing text version", { textVersion: undefined }],
    ["a long install id", { installId: "x".repeat(129) }],
    ["a control character in the install id", { installId: "a\nb" }],
  ])("rejects %s with 400", async (_name, patch) => {
    const h = updatesHarness();
    const { response, body } = await h.optIn("ana@example.test", patch);
    expect(response.status).toBe(400);
    expect(body).toEqual({ error: "invalid_request" });
    expect(h.emails).toHaveLength(0);
  });

  it("accepts a missing install id", async () => {
    const h = updatesHarness();
    const { response } = await h.optIn("ana@example.test", { installId: undefined });
    expect(response.status).toBe(200);
    expect(h.receipts("ana@example.test")[0]!.install_id).toBeNull();
  });

  it("answers 415 to a body that is not JSON", async () => {
    const h = updatesHarness();
    const response = await h.fetch("/api/updates-consent", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
    expect(response.status).toBe(415);
  });

  it("answers 429 when the limiter refuses, keyed by the client address (AC-06)", async () => {
    const h = updatesHarness();
    h.limits.allowed = false;
    const response = await h.consent({ status: "opted_in", email: "ana@example.test", textVersion: "v1" }, { "CF-Connecting-IP": "203.0.113.7" });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited" });
    expect(h.limits.keys).toEqual(["203.0.113.7"]);
    expect(h.emails).toHaveLength(0);
  });
});

describe("withdraw", () => {
  const ADDRESS = "ana@example.test";
  const older = (h: ReturnType<typeof updatesHarness>) => h.d1.db.exec("UPDATE subscribers SET confirm_sent_at = confirm_sent_at - 601");
  const withdraw = async (h: ReturnType<typeof updatesHarness>, status: string, receipt: string | undefined) => {
    const response = await h.consent({ status, receipt });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  };
  const state = (h: ReturnType<typeof updatesHarness>) => h.subscriber(ADDRESS)!.status;
  const confirm = (h: ReturnType<typeof updatesHarness>) => h.postForm("/confirm", { t: h.confirmToken() });

  it.each(["withdrawn", "declined"])("unsubscribes a pending address on %s (AC-04)", async (status) => {
    const h = updatesHarness();
    const { body } = await h.optIn(ADDRESS);
    await withdraw(h, status, body.receipt);
    expect(h.subscriber(ADDRESS)!.unsubscribed_at).not.toBeNull();
    expect(h.receipts(ADDRESS)[0]!.withdrawn_at).not.toBeNull();
    await withdraw(h, status, body.receipt);
    expect(state(h)).toBe("unsubscribed");
  });

  it.each(["withdrawn", "declined"])("ends only the subscription that the same link confirmed on %s", async (status) => {
    const h = updatesHarness();
    const r1 = await h.optIn(ADDRESS);
    older(h);
    const r2 = await h.optIn(ADDRESS);
    expect(h.emails).toHaveLength(2);
    expect((await confirm(h)).status).toBe(200);
    await withdraw(h, status, r1.body.receipt);
    expect(state(h)).toBe("confirmed");
    expect(h.receipts(ADDRESS).filter((row) => row.withdrawn_at !== null)).toHaveLength(1);
    await withdraw(h, status, r2.body.receipt);
    expect(state(h)).toBe("unsubscribed");
  });

  it.each(["withdrawn", "declined"])("keeps a confirmed address when the receipt came after the confirmation on %s", async (status) => {
    const h = updatesHarness();
    await h.optIn(ADDRESS);
    await confirm(h);
    const r3 = await h.optIn(ADDRESS);
    expect(h.emails).toHaveLength(1);
    await withdraw(h, status, r3.body.receipt);
    expect(state(h)).toBe("confirmed");
    expect(h.receipts(ADDRESS).filter((row) => row.withdrawn_at !== null)).toHaveLength(1);
  });

  it("lets a receipt in the same link window end the confirmed subscription", async () => {
    const h = updatesHarness();
    await h.optIn(ADDRESS);
    const r2 = await h.optIn(ADDRESS);
    expect(h.emails).toHaveLength(1);
    await confirm(h);
    await withdraw(h, "withdrawn", r2.body.receipt);
    expect(state(h)).toBe("unsubscribed");
  });

  it("keeps a pending address when a newer link replaced the receipt's link", async () => {
    const h = updatesHarness();
    const r1 = await h.optIn(ADDRESS);
    older(h);
    await h.optIn(ADDRESS);
    await withdraw(h, "withdrawn", r1.body.receipt);
    expect(state(h)).toBe("pending");
  });

  it("lets the new receipt withdraw a link that an earlier withdrawal left open", async () => {
    const h = updatesHarness();
    const r1 = await h.optIn(ADDRESS);
    const token = h.confirmToken();
    await withdraw(h, "withdrawn", r1.body.receipt);
    const r2 = await h.optIn(ADDRESS);
    expect(h.emails).toHaveLength(1);
    expect(state(h)).toBe("pending");
    expect((await h.postForm("/confirm", { t: token })).status).toBe(200);
    await withdraw(h, "declined", r2.body.receipt);
    expect(state(h)).toBe("unsubscribed");
  });

  it("rejects an old link after a resubscribe and keeps old receipts harmless", async () => {
    const h = updatesHarness();
    const r1 = await h.optIn(ADDRESS);
    const l1 = h.confirmToken();
    await h.postForm("/confirm", { t: l1 });
    await h.fetch(`/unsubscribe?t=${h.subscriber(ADDRESS)!.unsubscribe_token}`, { method: "POST" });
    expect(state(h)).toBe("unsubscribed");
    older(h);
    await h.optIn(ADDRESS);
    expect(h.emails).toHaveLength(2);
    expect((await h.postForm("/confirm", { t: l1 })).status).toBe(410);
    expect(h.subscriber(ADDRESS)!.confirmed_hash).toBeNull();
    expect((await confirm(h)).status).toBe(200);
    const confirmed = h.subscriber(ADDRESS)!;
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.confirmed_hash).toBe(await sha256(h.confirmToken()));
    await withdraw(h, "withdrawn", r1.body.receipt);
    expect(state(h)).toBe("confirmed");
  });

  it("stores no link on a receipt made for a confirmed address", async () => {
    const h = updatesHarness();
    await h.confirmed(ADDRESS);
    await h.optIn(ADDRESS);
    const hashes = h.d1.rows<{ confirm_hash: string | null }>("SELECT confirm_hash FROM receipts ORDER BY rowid").map((row) => row.confirm_hash);
    expect(hashes[0]).not.toBeNull();
    expect(hashes[1]).toBeNull();
  });

  it("answers 404 unknown_receipt for an unknown receipt (AC-05)", async () => {
    const h = updatesHarness();
    const response = await h.consent({ status: "withdrawn", receipt: "A".repeat(43) });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "unknown_receipt" });
  });

  it("answers 400 to a receipt of the wrong shape", async () => {
    const h = updatesHarness();
    const response = await h.consent({ status: "withdrawn", receipt: "short" });
    expect(response.status).toBe(400);
  });
});

describe("confirm page", () => {
  it("does not confirm on GET and confirms on POST (AC-03)", async () => {
    const h = updatesHarness();
    await h.optIn("ana@example.test");
    const token = h.confirmToken();

    const view = await h.fetch(`/confirm?t=${token}`);
    expect(view.status).toBe(200);
    const html = await view.text();
    expect(html).toContain("Confirm subscription");
    expect(html).toContain('method="post"');
    expect(html).toContain("<title>Seira updates</title>");
    expect(html).toContain('name="viewport"');
    expect(view.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(view.headers.get("cache-control")).toBe("no-store");
    expect(view.headers.get("x-robots-tag")).toBe("noindex");
    expect(h.subscriber("ana@example.test")?.status).toBe("pending");

    const done = await h.postForm("/confirm", { t: token });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("You&#39;re subscribed. We&#39;ll email you about new Seira features and tips, about twice a month.");
    const subscriber = h.subscriber("ana@example.test")!;
    expect(subscriber.status).toBe("confirmed");
    expect(subscriber.confirmed_at).not.toBeNull();
    expect(subscriber.confirm_hash).toBeNull();
  });

  it("answers 410 to an unknown token", async () => {
    const h = updatesHarness();
    await h.optIn("ana@example.test");
    const response = await h.postForm("/confirm", { t: "B".repeat(43) });
    expect(response.status).toBe(410);
    expect(await response.text()).toContain("This link has expired. Turn on updates again in Seira.");
    expect(h.subscriber("ana@example.test")?.status).toBe("pending");
  });

  it("answers 410 when an old token meets a withdrawn address", async () => {
    const h = updatesHarness();
    const { body } = await h.optIn("ana@example.test");
    const token = h.confirmToken();
    await h.consent({ status: "withdrawn", receipt: body.receipt });
    expect((await h.postForm("/confirm", { t: token })).status).toBe(410);
    expect(h.subscriber("ana@example.test")?.status).toBe("unsubscribed");
  });

  it("answers 410 to a token older than 7 days", async () => {
    const h = updatesHarness();
    await h.optIn("ana@example.test");
    h.d1.db.exec("UPDATE subscribers SET confirm_sent_at = confirm_sent_at - 8 * 24 * 3600");
    const response = await h.postForm("/confirm", { t: h.confirmToken() });
    expect(response.status).toBe(410);
    expect(h.subscriber("ana@example.test")?.status).toBe("pending");
  });

  it("answers 410 to a token that a newer email replaced", async () => {
    const h = updatesHarness();
    await h.optIn("ana@example.test");
    const old = h.confirmToken();
    h.d1.db.exec("UPDATE subscribers SET confirm_sent_at = confirm_sent_at - 601");
    await h.optIn("ana@example.test");
    expect((await h.postForm("/confirm", { t: old })).status).toBe(410);
    expect((await h.postForm("/confirm", { t: h.confirmToken() })).status).toBe(200);
  });

  it("escapes the token in the page", async () => {
    const h = updatesHarness();
    const response = await h.fetch(`/confirm?t=${encodeURIComponent('"><script>x</script>')}`);
    expect(response.status).toBe(410);
    expect(await response.text()).not.toContain("<script>");
  });
});

describe("unsubscribe page", () => {
  async function pending() {
    const h = updatesHarness();
    await h.confirmed("ana@example.test");
    return { h, token: h.subscriber("ana@example.test")!.unsubscribe_token };
  }

  it("shows a button on GET and does not unsubscribe", async () => {
    const { h, token } = await pending();
    const view = await h.fetch(`/unsubscribe?t=${token}`);
    expect(view.status).toBe(200);
    expect(await view.text()).toContain("Unsubscribe</button>");
    expect(h.subscriber("ana@example.test")?.status).toBe("confirmed");
  });

  it("unsubscribes on a form POST", async () => {
    const { h, token } = await pending();
    const response = await h.postForm(`/unsubscribe?t=${token}`, {});
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("You&#39;re unsubscribed. You won&#39;t get Seira updates anymore.");
    expect(h.subscriber("ana@example.test")?.status).toBe("unsubscribed");
  });

  it("unsubscribes on the one-click POST body (AC-08)", async () => {
    const { h, token } = await pending();
    const response = await h.fetch(`/unsubscribe?t=${token}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(response.status).toBe(200);
    expect(h.subscriber("ana@example.test")?.status).toBe("unsubscribed");
  });

  it("answers an unknown token with the same page and status", async () => {
    const { h } = await pending();
    const response = await h.postForm(`/unsubscribe?t=${"C".repeat(43)}`, {});
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("unsubscribed");
    expect(h.subscriber("ana@example.test")?.status).toBe("confirmed");
  });
});

describe("other routes", () => {
  it("redirects the root to the site", async () => {
    const response = await updatesHarness().fetch("/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://site.test/");
  });

  it("answers 404 plain text elsewhere", async () => {
    const response = await updatesHarness().fetch("/nothing");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });
});
