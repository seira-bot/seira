// Email sign-in through the Seira control plane, or through the server's own mail server when SEIRA_SIGNIN_SMTP_URL is
// set: the code exchange is server-side, so a browser only talks to this server, and a server with an empty allow-list
// does not expose the routes. The result is an ordinary local session.
import { cloudOriginFor } from "../electron/cloud-signin.mjs";
import { resolveServerControlPlaneURL } from "../electron/companion-account-service.mjs";
import { ControlPlaneError, createControlPlaneClient, normalizeAccountEmail, type ControlPlaneClient } from "../electron/control-plane-client.mjs";
import { createSeiraCloudSignIn } from "../electron/seira-cloud-sign-in.mjs";
import type { Scope } from "./sessions.ts";
import { createSignInMail, SignInMailError, type MailTransport, type SignInMail } from "./sign-in-mail.ts";
import { userError, type UserError } from "./user-errors.ts";

/** Who may sign in. `a@b.com` is that address; `@b.com` is everyone at b.com. */
export interface SignInAllowList {
  admins: string[];
  members: string[];
}

/** Commas, spaces or newlines between entries; case does not matter. */
export function parseAllowList(value: string | undefined | null): string[] {
  return (value ?? "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function allowedScopes(rawEmail: string, list: SignInAllowList): Scope[] | null {
  const email = rawEmail.trim().toLowerCase();
  if (!email.includes("@")) return null;
  const matches = (entry: string) => (entry.startsWith("@") ? email.endsWith(entry) && email.length > entry.length : entry === email);
  if (list.admins.some(matches)) return ["admin", "client"];
  if (list.members.some(matches)) return ["client"];
  return null;
}

export function signInEnabled(list: SignInAllowList): boolean {
  return list.admins.length + list.members.length > 0;
}

export type SignInFailure = { ok: false; status: number } & UserError;

export interface EmailSignIn {
  enabled(): boolean;
  /** `target`: the host the code signs in to, for the email's subject. `source`: who asked, for the limit on codes. */
  start(email: string, target?: string | null, source?: string): Promise<{ ok: true } | SignInFailure>;
  verify(email: string, code: string): Promise<{ ok: true; email: string; userId: string; scopes: Scope[] } | SignInFailure>;
}

const NOT_WELCOME: SignInFailure = { ok: false, status: 403, ...userError("serverError.email.notAllowed") };
const CODE_WRONG: SignInFailure = { ok: false, status: 401, ...userError("serverError.email.codeWrong") };
const CODE_FORMAT: SignInFailure = { ok: false, status: 400, ...userError("serverError.email.codeFormat") };
const TOO_MANY: SignInFailure = { ok: false, status: 429, ...userError("serverError.email.tooMany") };

const MAX_OPEN_CODES = 1000;

const codeShapeOk = (code: string): boolean => code.length <= 32 && /^\d{8}$/.test(code.replace(/[\s-]/g, ""));

export function createEmailSignIn(options: {
  allow: SignInAllowList | (() => SignInAllowList);
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  client?: ControlPlaneClient;
  mailTransport?: MailTransport;
  /** True while this server is signed in to a Seira account: Seira's account service then sends the codes. */
  seiraAccount?: () => boolean;
  /** The server's release version, which Seira's sign-in names the device with. */
  version?: string;
}): EmailSignIn {
  const env = options.env ?? process.env;
  const allow = () => (typeof options.allow === "function" ? options.allow() : options.allow);
  const smtpUrl = env.SEIRA_SIGNIN_SMTP_URL?.trim();
  if (smtpUrl) {
    return mailedSignIn(allow, createSignInMail({ url: smtpUrl, from: env.SEIRA_SIGNIN_SMTP_FROM,
      ...(options.mailTransport ? { transport: options.mailTransport } : {}) }));
  }
  // An address reaches Seira's account service only when this server is signed in to a Seira account or the operator names a service.
  const controlPlaneURL = (): string =>
    Object.hasOwn(env, "SEIRA_CONTROL_PLANE_URL") || options.seiraAccount?.() === true ? resolveServerControlPlaneURL({ environment: env }) : "";
  const newClient = (): ControlPlaneClient => {
    if (options.client) return options.client;
    const baseURL = controlPlaneURL();
    if (!baseURL) throw new Error("this server has no account service for email sign-in");
    return createControlPlaneClient({
      baseURL,
      fetchImpl: options.fetchImpl,
      cloudSignIn: createSeiraCloudSignIn({
        origin: cloudOriginFor(env),
        identity: { deviceName: "Seira server", platform: process.platform, appVersion: options.version },
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      }),
    });
  };
  const open = new Map<string, ControlPlaneClient>();
  const remember = (email: string, client: ControlPlaneClient): void => {
    open.delete(email);
    open.set(email, client);
    for (const oldest of open.keys()) {
      if (open.size <= MAX_OPEN_CODES) break;
      open.delete(oldest);
    }
  };
  return {
    enabled: () => signInEnabled(allow()) && (options.client !== undefined || controlPlaneURL() !== ""),
    async start(rawEmail) {
      const email = normalizeAccountEmail(rawEmail);
      if (!email) return { ok: false, status: 400, ...userError("serverError.email.invalid") };
      if (!allowedScopes(email, allow())) return NOT_WELCOME;
      try {
        const client = newClient();
        await client.requestOTP(email);
        remember(email, client);
      } catch (error) {
        if (error instanceof ControlPlaneError && error.status === 429) return TOO_MANY;
        return unavailable(error);
      }
      return { ok: true };
    },
    async verify(rawEmail, code) {
      if (!codeShapeOk(code)) return CODE_FORMAT;
      const email = normalizeAccountEmail(rawEmail);
      if (!email || !allowedScopes(email, allow())) return CODE_WRONG;
      let client: ControlPlaneClient;
      let verified: { accountToken: string; user: { id: string; email: string } };
      try {
        const sent = open.get(email);
        client = sent ?? newClient();
        if (!sent && (await client.accounts()) === "seira-cloud") return CODE_WRONG;
        verified = await client.verifyOTP(email, code);
      } catch (error) {
        // The client refuses a malformed code before any request (status 0);
        // the control plane's own "invalid_otp" is a wrong or expired code.
        if (error instanceof ControlPlaneError && error.code === "invalid_otp" && !error.status) {
          return { ok: false, status: 400, ...userError("serverError.email.codeFormat") };
        }
        if (error instanceof ControlPlaneError && error.status === 429) return TOO_MANY;
        if (error instanceof ControlPlaneError && error.status === 410) {
          open.delete(email);
          return CODE_WRONG;
        }
        if (error instanceof ControlPlaneError && (error.status === 400 || error.status === 401 || error.status === 403)) {
          return { ok: false, status: 401, ...userError("serverError.email.codeWrong") };
        }
        return unavailable(error);
      }
      open.delete(email);
      void client.signOut(verified.accountToken).catch(() => undefined);
      const scopes = allowedScopes(verified.user.email, allow());
      if (!scopes) return NOT_WELCOME;
      return { ok: true, email: verified.user.email, userId: verified.user.id, scopes };
    },
  };
}

function mailedSignIn(allow: () => SignInAllowList, mail: SignInMail): EmailSignIn {
  return {
    enabled: () => signInEnabled(allow()),
    async start(rawEmail, target, source) {
      const email = normalizeAccountEmail(rawEmail);
      if (!email) return { ok: false, status: 400, ...userError("serverError.email.invalid") };
      if (!allowedScopes(email, allow())) return NOT_WELCOME;
      try {
        if ((await mail.send(email, target, source)) === "tooSoon") return { ok: false, status: 429, ...userError("serverError.email.tooMany") };
      } catch (error) {
        console.warn(`sign-in code not sent: ${error instanceof Error ? error.message : String(error)}`);
        return { ok: false, status: 502, ...userError("serverError.email.unavailable", { detail: error instanceof SignInMailError ? error.message : "the mail server refused it" }) };
      }
      return { ok: true };
    },
    async verify(rawEmail, code) {
      if (!codeShapeOk(code)) return CODE_FORMAT;
      const email = normalizeAccountEmail(rawEmail);
      if (!email || !allowedScopes(email, allow())) return CODE_WRONG;
      const checked = mail.check(email, code);
      if (checked === "format") return { ok: false, status: 400, ...userError("serverError.email.codeFormat") };
      if (checked === "tooMany") return { ok: false, status: 429, ...userError("serverError.email.tooMany") };
      if (checked === "wrong") return { ok: false, status: 401, ...userError("serverError.email.codeWrong") };
      const scopes = allowedScopes(email, allow());
      return scopes ? { ok: true, email, userId: `email:${email}`, scopes } : NOT_WELCOME;
    },
  };
}

function unavailable(error: unknown): SignInFailure {
  const detail = error instanceof ControlPlaneError ? `${error.code}${error.status ? ` (${error.status})` : ""}` : error instanceof Error ? error.message : String(error);
  return { ok: false, status: 502, ...userError("serverError.email.unavailable", { detail }) };
}
