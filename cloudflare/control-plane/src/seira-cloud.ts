import { z } from "zod";

import { HTTPError } from "./http";

/** A Seira Cloud desktop token: `omc_` and 43 base64url characters. */
const CLOUD_TOKEN = /^omc_[A-Za-z0-9_-]{43}$/;
const CLOUD_ACCOUNT_ID = /^acc_[0-9A-HJKMNP-TV-Z]{26}$/;
const SESSION_URL = "https://cloud.seira.bot/api/cloud/desktop/session";
const SESSION_TIMEOUT_MS = 5_000;

const sessionSchema = z.object({
  account: z.object({
    id: z.string().regex(CLOUD_ACCOUNT_ID),
    email: z.string().min(1).max(320),
  }),
});

export interface SeiraCloudAccount {
  id: string;
  email: string;
}

function unavailable(): HTTPError {
  return new HTTPError(503, "account_service_unavailable");
}

/**
 * The account that owns the request's Seira Cloud token, or null when the
 * request has no valid token. Seira Cloud answering 401 means "signed out".
 * Any other failure throws 503, so an outage never looks like a sign-out.
 *
 * Only the token goes to Seira Cloud. Do not add the `x-seira-version` or
 * `x-openmausbot-version` header: Seira Cloud would store it as the device's
 * app version.
 */
export async function seiraCloudAccount(request: Request, env: Env): Promise<SeiraCloudAccount | null> {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  if (!token || !CLOUD_TOKEN.test(token)) return null;

  let response: Response;
  try {
    response = await env.SEIRA_CLOUD.fetch(new Request(SESSION_URL, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
    }));
  } catch {
    throw unavailable();
  }
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw unavailable();
  }
  const parsed = sessionSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw unavailable();
  return { id: parsed.data.account.id, email: parsed.data.account.email };
}
