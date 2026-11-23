import { env } from "cloudflare:workers";

/** Crockford base32 has no I, L, O or U. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function cloudToken(seed: string): string {
  return `omc_${seed.repeat(43).slice(0, 43)}`;
}

export function cloudAccountId(seed: number): string {
  return `acc_${"0".repeat(24)}${CROCKFORD[Math.floor(seed / 32) % 32]}${CROCKFORD[seed % 32]}`;
}

export type StubAnswer = "ok" | "unauthorized" | "server_error" | "bad_body" | "network_error";

/** A Seira Cloud that knows some tokens. A token it does not know is a 401. */
export class FakeSeiraCloud {
  readonly requests: Request[] = [];
  readonly accounts = new Map<string, { id: string; email: string }>();
  override: StubAnswer | null = null;

  add(token: string, id: string, email: string): void {
    this.accounts.set(token, { id, email });
  }

  readonly binding = {
    fetch: async (request: Request): Promise<Response> => {
      this.requests.push(request);
      if (this.override === "network_error") throw new TypeError("network failure");
      if (this.override === "server_error") return Response.json({ error: "internal" }, { status: 500 });
      if (this.override === "bad_body") return Response.json({ account: { id: "not-an-account" } });
      if (this.override === "unauthorized") return Response.json({ error: "invalid_token" }, { status: 401 });
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      const account = this.accounts.get(token);
      if (!account) return Response.json({ error: "invalid_token" }, { status: 401 });
      return Response.json({
        expiresAt: Date.now() + 60_000,
        device: { id: "dev_1" },
        account,
        entitlement: null,
        teams: [],
      });
    },
  };
}

/** The Seira deployment's Env: Seira Cloud accounts, and none of the Better Auth settings. */
export function seiraCloudEnv(stub: FakeSeiraCloud, vars: Record<string, string> = {}): Env {
  const base: Record<string, unknown> = { ...env };
  for (const name of ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "EMAIL_FROM", "EMAIL"]) {
    Reflect.deleteProperty(base, name);
  }
  return { ...base, ACCOUNT_SERVICE: "seira-cloud", SEIRA_CLOUD: stub.binding, ...vars } as unknown as Env;
}
