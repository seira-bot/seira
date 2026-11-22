import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EmailSignIn } from "../account-signin.ts";
import { userError } from "../user-errors.ts";
import { emailSignInRoute } from "./email-sign-in.ts";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function fixture(verify: EmailSignIn["verify"]) {
  const noteFailure = vi.fn();
  const deps = {
    cloudHome: false,
    emailSignIn: { enabled: () => true, start: async () => ({ ok: true }) as const, verify } as EmailSignIn,
    sessions: {
      attemptAllowed: () => ({ ok: true }) as const,
      noteFailure,
      clearFailures: () => {},
      issue: () => { throw new Error("no session expected"); },
    },
    cookieName: "seira_session",
    environment: () => ({}),
    target: () => null,
  };
  const server = createServer((req, res) => {
    void emailSignInRoute(deps, req, res, "/api/auth/email/verify", "POST");
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no test port");
  const post = () => fetch(`http://127.0.0.1:${address.port}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "her@example.test", code: "00000000" }),
  });
  return { noteFailure, post };
}

describe("email sign-in verify", () => {
  it.each([
    [401, true],
    [403, true],
    [429, true],
    [400, false],
    [502, false],
  ])("counts a failure for the source when verify answers %i: %s", async (status, counted) => {
    const { noteFailure, post } = await fixture(async () => ({ ok: false, status, ...userError("serverError.email.codeWrong") }));
    expect((await post()).status).toBe(status);
    expect(noteFailure).toHaveBeenCalledTimes(counted ? 1 : 0);
  });
});
