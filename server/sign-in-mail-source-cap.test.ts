import { describe, expect, it } from "vitest";

import { createSignInMail, SIGNIN_CODE_TTL_MS, SIGNIN_CODES_PER_SOURCE, type MailMessage } from "./sign-in-mail.ts";

const URL_ = "smtps://signin%40example.test:p%40ss@smtp.example.test:465";

function setup(refuse = () => false) {
  const sent: MailMessage[] = [];
  let clock = 0;
  const mail = createSignInMail({
    url: URL_,
    now: () => clock,
    transport: { sendMail: async (message: MailMessage) => { if (refuse()) throw new Error("550 relay denied"); sent.push(message); } },
  });
  return { sent, mail, tick: (ms: number) => { clock += ms; } };
}

describe("one source asking for codes to many addresses", () => {
  it("cannot use up the codes every other source may ask for, nor mail a whole domain", async () => {
    const { sent, mail, tick } = setup();
    for (let i = 0; i < 1_000; i += 1) {
      await mail.send(`x${i}@example.test`, null, "203.0.113.7");
      tick(1);
    }
    expect(sent.length).toBeLessThan(100);
    expect(await mail.send("her@example.test", null, "198.51.100.2")).toBe("sent");
  });

  it("gets a fixed number of codes in ten minutes, then more when the window has passed", async () => {
    const { sent, mail, tick } = setup();
    for (let i = 0; i < SIGNIN_CODES_PER_SOURCE; i += 1) expect(await mail.send(`x${i}@example.test`, null, "203.0.113.7")).toBe("sent");
    expect(await mail.send("next@example.test", null, "203.0.113.7")).toBe("tooSoon");
    expect(sent).toHaveLength(SIGNIN_CODES_PER_SOURCE);
    tick(SIGNIN_CODE_TTL_MS);
    expect(await mail.send("next@example.test", null, "203.0.113.7")).toBe("sent");
  });

  it("does not count a code the mail server refused", async () => {
    let refuse = true;
    const { mail } = setup(() => refuse);
    for (let i = 0; i < SIGNIN_CODES_PER_SOURCE + 5; i += 1) await expect(mail.send(`x${i}@example.test`, null, "203.0.113.7")).rejects.toThrow("550");
    refuse = false;
    expect(await mail.send("her@example.test", null, "203.0.113.7")).toBe("sent");
  });

  it("does not cap the empty source that internal callers use", async () => {
    const { sent, mail } = setup();
    for (let i = 0; i < SIGNIN_CODES_PER_SOURCE + 5; i += 1) expect(await mail.send(`x${i}@example.test`)).toBe("sent");
    expect(sent).toHaveLength(SIGNIN_CODES_PER_SOURCE + 5);
  });
});
