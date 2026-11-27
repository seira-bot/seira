import { describe, expect, it } from "vitest";

import { createSignInMail, SIGNIN_CODE_RESEND_MS, SIGNIN_CODE_TTL_MS, SIGNIN_CODES_PER_SOURCE, type MailMessage } from "./sign-in-mail.ts";

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

describe("sends that run at the same time", () => {
  /** A mail server that holds each send until the test settles it. */
  function slowSetup() {
    const held: { message: MailMessage; settle: (fail: boolean) => void }[] = [];
    let clock = 0;
    const mail = createSignInMail({
      url: URL_,
      now: () => clock,
      transport: {
        sendMail: (message: MailMessage) => new Promise<void>((resolve, reject) => {
          held.push({ message, settle: (fail) => (fail ? reject(new Error("550 relay denied")) : resolve()) });
        }),
      },
    });
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    return { held, mail, flush, tick: (ms: number) => { clock += ms; } };
  }

  it("gives back only the slot of the send that failed, so the cap stays exact", async () => {
    const { held, mail, flush, tick } = slowSetup();
    const failing = mail.send("a@example.test", null, "203.0.113.7");
    const failed = expect(failing).rejects.toThrow("550");
    await flush();
    tick(5 * 60_000);
    const other = mail.send("b@example.test", null, "203.0.113.7");
    await flush();
    held[0]!.settle(true);
    await failed;
    held[1]!.settle(false);
    expect(await other).toBe("sent");
    // The failed send was asked for at minute 0 and the other at minute 5: at minute 10 only the other still counts.
    tick(5 * 60_000);
    const more: Promise<string>[] = [];
    for (let i = 0; i < SIGNIN_CODES_PER_SOURCE; i += 1) {
      more.push(mail.send(`x${i}@example.test`, null, "203.0.113.7"));
      await flush();
    }
    for (const send of held.slice(2)) send.settle(false);
    expect((await Promise.all(more)).filter((result) => result === "sent")).toHaveLength(SIGNIN_CODES_PER_SOURCE - 1);
  });

  it("keeps the code of a newer send to the same address when an older send fails", async () => {
    const { held, mail, flush, tick } = slowSetup();
    const older = mail.send("her@example.test", null, "203.0.113.7");
    const olderFailed = expect(older).rejects.toThrow("550");
    await flush();
    tick(SIGNIN_CODE_RESEND_MS);
    const newer = mail.send("her@example.test", null, "203.0.113.7");
    await flush();
    held[0]!.settle(true);
    await olderFailed;
    held[1]!.settle(false);
    expect(await newer).toBe("sent");
    const code = /^(\d{8})$/m.exec(held[1]!.message.text)![1]!;
    expect(mail.check("her@example.test", code)).toBe("ok");
  });
});
