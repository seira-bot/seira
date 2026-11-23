import { accountSession, createAuth } from "./auth";
import type { ControlPlaneConfig } from "./config";
import { HTTPError } from "./http";
import { seiraCloudAccount } from "./seira-cloud";

export interface AccountUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

/** Who owns a request's account bearer token, in either account mode. */
export interface AccountService {
  /** Seira Cloud accounts have no row in this database until the first request. */
  shadowUsers: boolean;
  resolve(request: Request): Promise<AccountUser | null>;
}

export function createAccountService(
  env: Env,
  ctx: ExecutionContext,
  config: ControlPlaneConfig,
  requestId: string,
): AccountService {
  if (config.accountService === "seira-cloud") {
    return {
      shadowUsers: true,
      async resolve(request) {
        const account = await seiraCloudAccount(request, env);
        return account ? { id: account.id, email: account.email, name: "", emailVerified: true } : null;
      },
    };
  }
  let auth: ReturnType<typeof createAuth> | null = null;
  return {
    shadowUsers: false,
    async resolve(request) {
      auth ??= createAuth(env, ctx, config, requestId);
      const session = await accountSession(request, auth);
      if (!session) return null;
      const { id, email, name, emailVerified } = session.user;
      return { id, email, name, emailVerified };
    },
  };
}

/** The placeholder keeps real addresses out of this database and cannot collide with another user. */
function shadowEmail(accountId: string): string {
  return `${accountId}@seira-cloud.invalid`;
}

/** 401 without a valid session; 403 `account_blocked` for a blocked account. */
export async function requireAccount(
  request: Request,
  env: Env,
  accounts: AccountService,
): Promise<AccountUser> {
  const user = await accounts.resolve(request);
  if (!user) throw new HTTPError(401, "unauthorized");

  const blocked = await env.DB.prepare("SELECT 1 AS blocked FROM account_blocks WHERE user_id = ?")
    .bind(user.id).first();
  if (blocked) throw new HTTPError(403, "account_blocked");

  if (accounts.shadowUsers) {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, '', ?, 1, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).bind(user.id, shadowEmail(user.id), now, now).run();
  }
  return user;
}
