import { describe, expect, it, vi } from "vitest";

import type { ControlPlaneClient } from "../electron/control-plane-client.mjs";
import { allowedScopes, createEmailSignIn, parseAllowList, signInEnabled } from "./account-signin.ts";
import { startControlPlaneStub, type ControlPlaneStub } from "./testing/control-plane-stub.ts";

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

describe("emailed codes from Seira's account service, with no mail server", () => {
  const allow = { admins: ["milind@example.test"], members: ["guest@example.test"] };
  const envFor = (stub: ControlPlaneStub) => ({ SEIRA_CONTROL_PLANE_URL: stub.url, SEIRA_CLOUD_ORIGIN: stub.url });
  const withService = async (run: (stub: ControlPlaneStub) => Promise<void>) => {
    const stub = await startControlPlaneStub({ accounts: "seira-cloud" });
    try {
      await run(stub);
    } finally {
      await stub.close();
    }
  };

  const startBody = { cloudContractVersion: 1, attempt: "a".repeat(43), expiresIn: 600, resendAfter: 30, signupOpen: true };
  const serviceAnswering = (start: { status: number; body: unknown }, verify: { status: number; body: unknown }) =>
    (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/healthz")) return Response.json({ ok: true, service: "seira-control-plane", accounts: "seira-cloud" });
      const answer = url.endsWith("/sign-in/start") ? start : verify;
      return Response.json(answer.body, { status: answer.status });
    }) as typeof fetch;

  it("sends the code through the Seira sign-in and never through Better Auth", async () => {
    await withService(async (stub) => {
      const signIn = createEmailSignIn({ allow, env: envFor(stub) });
      expect(await signIn.start("Milind@Example.test")).toEqual({ ok: true });
      expect(stub.calls.some((call) => call.startsWith("POST /api/auth/"))).toBe(false);
      expect(stub.cloudBodies[0]).toMatchObject({ path: "/api/cloud/app/sign-in/start", body: { email: "milind@example.test" } });

      expect(await signIn.verify("milind@example.test", "00000000")).toMatchObject({ ok: false, status: 401 });
      expect(await signIn.verify("milind@example.test", stub.otp)).toEqual({ ok: true, email: "milind@example.test", userId: stub.cloudAccountId, scopes: ["admin", "client"] });
      await vi.waitFor(() => expect(stub.calls).toContain("DELETE /api/cloud/desktop/session"));
    });
  });

  it("keeps two people who sign in at the same time apart", async () => {
    await withService(async (stub) => {
      const signIn = createEmailSignIn({ allow, env: envFor(stub) });
      expect(await signIn.start("milind@example.test")).toEqual({ ok: true });
      expect(await signIn.start("guest@example.test")).toEqual({ ok: true });
      expect(await signIn.verify("milind@example.test", stub.otp)).toMatchObject({ ok: true, email: "milind@example.test", scopes: ["admin", "client"] });
      expect(await signIn.verify("guest@example.test", stub.otp)).toMatchObject({ ok: true, email: "guest@example.test", scopes: ["client"] });
    });
  });

  it("calls a code with no open attempt wrong or expired, without asking Better Auth", async () => {
    await withService(async (stub) => {
      const signIn = createEmailSignIn({ allow, env: envFor(stub) });
      const result = await signIn.verify("milind@example.test", stub.otp);
      expect(result).toMatchObject({ ok: false, status: 401 });
      expect(stub.calls.some((call) => call.startsWith("POST /api/auth/"))).toBe(false);
    });
  });

  it("is on for a server signed in to a Seira account, and sends the code to Seira's own services", async () => {
    const asked: string[] = [];
    const service = serviceAnswering({ status: 200, body: startBody }, { status: 500, body: {} });
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      asked.push(String(input));
      return service(input, init);
    }) as typeof fetch;
    const signedOut = createEmailSignIn({ allow, env: {}, seiraAccount: () => false, fetchImpl });
    expect(signedOut.enabled()).toBe(false);
    const signedIn = createEmailSignIn({ allow, env: {}, seiraAccount: () => true, fetchImpl });
    expect(signedIn.enabled()).toBe(true);
    expect(await signedIn.start("milind@example.test")).toEqual({ ok: true });
    expect(asked).toEqual(["https://accounts.seira.bot/healthz", "https://cloud.seira.bot/api/cloud/app/sign-in/start"]);
    expect(createEmailSignIn({ allow: { admins: [], members: [] }, env: {}, seiraAccount: () => true }).enabled()).toBe(false);
  });

  it("lets SEIRA_CONTROL_PLANE_URL win over the Seira account, and an invalid one switch it off", () => {
    expect(createEmailSignIn({ allow, env: { SEIRA_CONTROL_PLANE_URL: "ftp://nope" }, seiraAccount: () => true }).enabled()).toBe(false);
    expect(createEmailSignIn({ allow, env: { SEIRA_CONTROL_PLANE_URL: "https://accounts.example.test" }, seiraAccount: () => false }).enabled()).toBe(true);
  });

  it("keeps the mail server path when SEIRA_SIGNIN_SMTP_URL is set, even when signed in to a Seira account", async () => {
    const sent: string[] = [];
    const signIn = createEmailSignIn({
      allow,
      env: { SEIRA_SIGNIN_SMTP_URL: "smtp://localhost:25", SEIRA_SIGNIN_SMTP_FROM: "signin@example.test" },
      mailTransport: { sendMail: async (message) => { sent.push(String(message.to)); } },
      seiraAccount: () => true,
      fetchImpl: (async () => { throw new Error("the account service must not be asked"); }) as typeof fetch,
    });
    expect(await signIn.start("milind@example.test")).toEqual({ ok: true });
    expect(sent).toEqual(["milind@example.test"]);
  });

  it("keeps a thousand open codes, then forgets the oldest", async () => {
    const service = serviceAnswering({ status: 200, body: startBody }, { status: 200, body: {} });
    const asked: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      asked.push(String(input));
      return service(input, init);
    }) as typeof fetch;
    const signIn = createEmailSignIn({ allow: { admins: [], members: ["@crowd.test"] }, env: {}, seiraAccount: () => true, fetchImpl });
    for (let person = 0; person < 1001; person += 1) expect(await signIn.start(`person${person}@crowd.test`)).toEqual({ ok: true });
    asked.length = 0;
    await signIn.verify("person1@crowd.test", "12345678");
    expect(asked.some((url) => url.endsWith("/healthz"))).toBe(false);
    await signIn.verify("person0@crowd.test", "12345678");
    expect(asked.some((url) => url.endsWith("/healthz"))).toBe(true);
  });

  it("tells a person to wait when Seira asks for a pause", async () => {
    const fetchImpl = serviceAnswering({ status: 429, body: { error: "rate_limited" } }, { status: 500, body: {} });
    const signIn = createEmailSignIn({ allow, env: {}, seiraAccount: () => true, fetchImpl });
    expect(await signIn.start("milind@example.test")).toMatchObject({ ok: false, status: 429 });
  });

  it("calls a code that Seira says has expired wrong or expired", async () => {
    const fetchImpl = serviceAnswering({ status: 200, body: startBody }, { status: 410, body: { error: "expired" } });
    const signIn = createEmailSignIn({ allow, env: {}, seiraAccount: () => true, fetchImpl });
    expect(await signIn.start("milind@example.test")).toEqual({ ok: true });
    expect(await signIn.verify("milind@example.test", "12345678")).toMatchObject({ ok: false, status: 401 });
  });
});
