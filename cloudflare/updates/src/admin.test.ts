import { describe, expect, it } from "vitest";

import { updatesHarness } from "./test-harness";

async function list(...emails: string[]) {
  const h = updatesHarness();
  for (const email of emails) await h.confirmed(email);
  h.emails.length = 0;
  return h;
}

describe("admin access", () => {
  it("answers 401 without a token, with a wrong token, or with no configured token (AC-10)", async () => {
    const h = updatesHarness();
    for (const token of [null, "wrong", ""]) {
      const stats = await h.admin("/admin/stats", {}, token);
      expect(stats.status).toBe(401);
      expect(await stats.json()).toEqual({ error: "unauthorized" });
      expect((await h.send({ subject: "S", text: "T" }, token)).status).toBe(401);
    }
    h.env.ADMIN_TOKEN = "";
    expect((await h.admin("/admin/stats", {}, "")).status).toBe(401);
    expect((await h.admin("/admin/stats", { headers: { authorization: "Bearer " } }, null)).status).toBe(401);
    expect(h.emails).toHaveLength(0);
  });

  it("counts subscribers by status", async () => {
    const h = updatesHarness();
    await h.confirmed("a@example.test");
    await h.confirmed("b@example.test");
    await h.optIn("c@example.test");
    const gone = await h.optIn("d@example.test");
    await h.consent({ status: "withdrawn", receipt: gone.body.receipt });
    const response = await h.admin("/admin/stats");
    expect(await response.json()).toEqual({ pending: 1, confirmed: 2, unsubscribed: 1 });
  });
});

describe("admin send", () => {
  it("emails only confirmed addresses, each with its own unsubscribe header (AC-09)", async () => {
    const h = await list("b@example.test", "a@example.test");
    await h.optIn("pending@example.test");
    const gone = await h.optIn("gone@example.test");
    await h.consent({ status: "withdrawn", receipt: gone.body.receipt });
    h.emails.length = 0;

    const response = await h.send({ subject: "News", text: "Hello <b>\n\nSecond line" });
    expect(await response.json()).toEqual({ sent: 2, failed: [], next: null });
    expect(h.emails.map((mail) => mail.to)).toEqual(["a@example.test", "b@example.test"]);
    for (const mail of h.emails) {
      const token = h.subscriber(mail.to)!.unsubscribe_token;
      const link = `https://updates.test/unsubscribe?t=${token}`;
      expect(mail.headers).toEqual({ "List-Unsubscribe": `<${link}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
      expect(mail.subject).toBe("News");
      expect(mail.text).toContain("Hello <b>");
      expect(mail.text).toContain(link);
      expect(mail.html).toContain("<p>Hello &lt;b&gt;</p><p>Second line</p>");
      expect(mail.html).toContain(`href="${link}"`);
    }
    expect(new Set(h.emails.map((mail) => mail.headers!["List-Unsubscribe"])).size).toBe(2);
  });

  it("uses the html a caller supplies", async () => {
    const h = await list("a@example.test");
    await h.send({ subject: "News", text: "T", html: "<h1>Custom</h1>" });
    expect(h.emails[0]!.html).toMatch(/^<h1>Custom<\/h1>/);
  });

  it("pages through the list with after and limit", async () => {
    const h = await list("a@example.test", "b@example.test", "c@example.test");
    const first = await (await h.send({ subject: "S", text: "T", limit: 2 })).json() as { sent: number; next: string | null };
    expect(first).toMatchObject({ sent: 2, next: "b@example.test" });
    const second = await (await h.send({ subject: "S", text: "T", limit: 2, after: first.next })).json() as { sent: number; next: string | null };
    expect(second).toMatchObject({ sent: 1, next: null });
    expect(h.emails.map((mail) => mail.to)).toEqual(["a@example.test", "b@example.test", "c@example.test"]);
  });

  it("returns a full last page with a next cursor", async () => {
    const h = await list("a@example.test", "b@example.test");
    const result = await (await h.send({ subject: "S", text: "T", limit: 2 })).json() as { next: string | null };
    expect(result.next).toBe("b@example.test");
  });

  it("records a failed send and keeps going", async () => {
    const h = await list("a@example.test", "b@example.test", "c@example.test");
    h.mail.failWhen = (message) => (message.to === "b@example.test" ? "E_RECIPIENT_SUPPRESSED" : undefined);
    const result = await (await h.send({ subject: "S", text: "T" })).json();
    expect(result).toEqual({ sent: 2, failed: [{ email: "b@example.test", code: "E_RECIPIENT_SUPPRESSED" }], next: null });
    expect(h.emails.map((mail) => mail.to)).toEqual(["a@example.test", "c@example.test"]);
  });

  it("sends a test to one address without reading the list", async () => {
    const h = await list("a@example.test");
    const result = await (await h.send({ subject: "S", text: "T", test: "Me@Example.Test" })).json();
    expect(result).toEqual({ sent: 1, failed: [], next: null });
    expect(h.emails.map((mail) => mail.to)).toEqual(["me@example.test"]);
    expect(h.emails[0]!.headers).toBeUndefined();
    expect(h.d1.sqlLog.filter((sql) => /status = 'confirmed' AND email >/.test(sql))).toHaveLength(0);
  });

  it.each([
    ["no subject", { text: "T" }],
    ["a subject with a line break", { subject: "a\nb", text: "T" }],
    ["no text", { subject: "S" }],
    ["a limit of 0", { subject: "S", text: "T", limit: 0 }],
    ["a limit of 41", { subject: "S", text: "T", limit: 41 }],
    ["a bad test address", { subject: "S", text: "T", test: "nope" }],
    ["an after that is not a string", { subject: "S", text: "T", after: 5 }],
  ])("rejects %s with 400", async (_name, body) => {
    const h = await list("a@example.test");
    const response = await h.send(body);
    expect(response.status).toBe(400);
    expect(h.emails).toHaveLength(0);
  });
});
