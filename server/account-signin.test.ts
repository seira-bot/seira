import { describe, expect, it } from "vitest";

import type { ControlPlaneClient } from "../electron/control-plane-client.mjs";
import { allowedScopes, createEmailSignIn, parseAllowList, signInEnabled } from "./account-signin.ts";
import { startControlPlaneStub } from "./testing/control-plane-stub.ts";

describe("the sign-in allow-list", () => {
  it("splits on commas, spaces and newlines and ignores case", () => {
    expect(parseAllowList(" Her@Example.test, @Agentada.test\nstaff@example.test ")).toEqual(["her@example.test", "@agentada.test", "staff@example.test"]);
    expect(parseAllowList(undefined)).toEqual([]);
  });

  it("maps addresses and @domains to scopes, and never matches a look-alike domain", () => {
    const list = { admins: ["her@example.test", "@agentada.test"], members: ["staff@example.test", "@partner.test"] };
    expect(allowedScopes("HER@example.test", list)).toEqual(["admin", "client"]);
    expect(allowedScopes("anyone@agentada.test", list)).toEqual(["admin", "client"]);
    expect(allowedScopes("staff@example.test", list)).toEqual(["client"]);
    expect(allowedScopes("x@partner.test", list)).toEqual(["client"]);
    expect(allowedScopes("x@evilagentada.test", list)).toBeNull();
    expect(allowedScopes("x@agentada.test.evil", list)).toBeNull();
    expect(allowedScopes("@agentada.test", list)).toBeNull();
    expect(allowedScopes("stranger@example.test", list)).toBeNull();
    expect(signInEnabled(list)).toBe(true);
    expect(signInEnabled({ admins: [], members: [] })).toBe(false);
  });
});

describe("the exchange with the control plane", () => {
  it("sends a code only to welcome addresses, turns the right code into scopes, and explains the wrong one", async () => {
    const stub = await startControlPlaneStub();
    try {
      const signIn = createEmailSignIn({
        allow: { admins: ["her@example.test"], members: ["@team.test"] },
        env: { ...process.env, SEIRA_CONTROL_PLANE_URL: stub.url },
      });
      expect(signIn.enabled()).toBe(true);
      expect(await signIn.start("nobody@example.test")).toMatchObject({ ok: false, status: 403 });
      expect(await signIn.start("not an email")).toMatchObject({ ok: false, status: 400 });
      expect(stub.calls).not.toContain("POST /api/auth/email-otp/send-verification-otp");
      expect(await signIn.start("Her@Example.test")).toEqual({ ok: true });
      expect(stub.calls).toContain("POST /api/auth/email-otp/send-verification-otp");

      const wrong = await signIn.verify("her@example.test", "00000000");
      expect(wrong).toMatchObject({ ok: false, status: 401 });
      expect(wrong.ok ? "" : wrong.error).toMatch(/wrong or has expired/);
      expect(await signIn.verify("her@example.test", "12")).toMatchObject({ ok: false, status: 400 });
      expect(await signIn.verify("nobody@example.test", stub.otp)).toEqual(wrong);

      const admin = await signIn.verify("her@example.test", stub.otp);
      expect(admin).toEqual({ ok: true, email: "her@example.test", userId: "user_stub", scopes: ["admin", "client"] });
      const member = await signIn.verify("someone@team.test", stub.otp);
      expect(member).toMatchObject({ ok: true, scopes: ["client"] });
      await new Promise((r) => setTimeout(r, 50));
      expect(stub.calls.filter((call) => call === "POST /api/auth/sign-out").length).toBe(2);
    } finally {
      await stub.close();
    }
  });

  it("verify answers listed and unlisted addresses the same", async () => {
    const stub = await startControlPlaneStub();
    try {
      const signIn = createEmailSignIn({
        allow: { admins: ["her@example.test"], members: [] },
        env: { ...process.env, SEIRA_CONTROL_PLANE_URL: stub.url },
      });
      const wrong = await signIn.verify("her@example.test", "00000000");
      const callsBefore = stub.calls.length;
      expect(wrong).toMatchObject({ ok: false, status: 401 });
      for (const address of ["nobody@example.test", "not an email", ""]) {
        expect(await signIn.verify(address, "00000000")).toEqual(wrong);
        expect(await signIn.verify(address, stub.otp)).toEqual(wrong);
      }
      expect(stub.calls.length).toBe(callsBefore);
      const badShape = await signIn.verify("her@example.test", "12");
      expect(badShape).toMatchObject({ ok: false, status: 400 });
      expect(await signIn.verify("nobody@example.test", "12")).toEqual(badShape);
    } finally {
      await stub.close();
    }

    const mailed = createEmailSignIn({
      allow: { admins: ["her@example.test"], members: [] },
      env: { SEIRA_SIGNIN_SMTP_URL: "smtp://localhost:25", SEIRA_SIGNIN_SMTP_FROM: "signin@example.test" },
      mailTransport: { sendMail: async () => undefined },
    });
    await mailed.start("her@example.test");
    const wrongMailed = await mailed.verify("her@example.test", "00000000");
    expect(wrongMailed).toMatchObject({ ok: false, status: 401 });
    expect(await mailed.verify("nobody@example.test", "00000000")).toEqual(wrongMailed);
    expect(await mailed.verify("nobody@example.test", "12")).toMatchObject({ ok: false, status: 400 });
  });

  it("is off with an empty allow-list and says so when the sign-in service is down", async () => {
    const off = createEmailSignIn({ allow: () => ({ admins: [], members: [] }) });
    expect(off.enabled()).toBe(false);
    const down = createEmailSignIn({ allow: { admins: ["a@b.test"], members: [] }, env: { ...process.env, SEIRA_CONTROL_PLANE_URL: "http://127.0.0.1:9" } });
    expect(await down.start("a@b.test")).toMatchObject({ ok: false, status: 502 });
  });

  it("is off without a mail server and without a phone account service, and on with either one", () => {
    const allow = { admins: ["a@b.test"], members: [] };
    expect(createEmailSignIn({ allow, env: {} }).enabled()).toBe(false);
    expect(createEmailSignIn({ allow, env: { SEIRA_CONTROL_PLANE_URL: "ftp://nope" } }).enabled()).toBe(false);
    expect(createEmailSignIn({ allow, env: { SEIRA_CONTROL_PLANE_URL: "https://accounts.example.test" } }).enabled()).toBe(true);
    expect(createEmailSignIn({ allow, env: {}, client: {} as ControlPlaneClient }).enabled()).toBe(true);
    expect(createEmailSignIn({ allow, env: { SEIRA_SIGNIN_SMTP_URL: "smtp://mail.example.test:25" } }).enabled()).toBe(true);
  });
});
