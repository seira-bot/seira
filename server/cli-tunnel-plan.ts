// What `serve --tunnel` needs before the server starts: the address, the connector, and its guardian.
import { cliCommand } from "./cli-invocation.ts";
import { reportableServerVersion } from "./environment.ts";
import {
  controlPlaneProblem,
  createTunnelAccount,
  createTunnelOrigin,
  describeTunnelAccount,
  ensureCloudflared,
  FLEET_CREDENTIAL_ENV,
  fleetAccess,
  fleetCredential,
  guardianEntry,
  tunnelAccess,
  type CompanionOriginEndpoint,
  type ManagedTunnelAccess,
  type TunnelAccount,
  type TunnelRecovery,
} from "./tunnel.ts";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface TunnelPlan {
  access: ManagedTunnelAccess;
  binary: string;
  guardian: string;
  origin: CompanionOriginEndpoint;
  account: TunnelAccount | null;
}

/**
 * A setup problem (no account, unreadable credentials, no connector) is an `error`, and serve stops.
 * A signed-in machine that gets no address this time (capacity, account limit, control plane down) is
 * `unavailable`, and serve keeps its other routes with the reason in the log (FR-221).
 */
export async function planTunnel(options: { dataDir: string }, log: (line: string) => void, recovery: TunnelRecovery): Promise<TunnelPlan | { error: string } | { unavailable: string }> {
  let access: ManagedTunnelAccess | null = null;
  let account: TunnelAccount | null = null;
  const fail = (error: string) => {
    account?.service.dispose();
    return { error };
  };
  const credential = fleetCredential();
  if (credential) {
    log(`tunnel: using the installation credential from ${FLEET_CREDENTIAL_ENV}`);
    try {
      access = await fleetAccess({ credential, version: reportableServerVersion() });
    } catch (error) {
      return { error: `--tunnel: ${message(error)}` };
    }
  } else {
    const problem = controlPlaneProblem(); if (problem) return { error: `--tunnel: ${problem}` };
    account = createTunnelAccount({ dataDir: options.dataDir, version: reportableServerVersion(), recovery, log: (line) => log(`tunnel: ${line}`) });
    if (account.credentials.status === "unavailable") return fail(`${account.credentials.file} exists but could not be read; fix or remove it`);
    if (!describeTunnelAccount(account.credentials.read()).email) {
      return fail(`no account on this machine yet: run ${cliCommand("login")} first, then ${cliCommand("serve --tunnel")}`);
    }
    let notice: { reason: string; withSaved: string } | null = null;
    try {
      const state = await account.service.retry();
      if (state.status === "signed-out") notice = { reason: `the sign-in on this machine expired; run ${cliCommand("login")} to renew it`, withSaved: " (serving the saved address until then)" };
      else if (state.message) notice = { reason: state.message, withSaved: " Serving the saved address for now." };
    } catch (error) {
      notice = { reason: `control plane not reachable right now (${message(error)})`, withSaved: "; using the saved address" };
    }
    access = tunnelAccess(account.credentials.read());
    if (!access) {
      account.service.dispose();
      return { unavailable: notice?.reason ?? "no public address was issued" };
    }
    if (notice) log(`tunnel: ${notice.reason}${notice.withSaved}`);
  }
  let binary: string;
  try {
    binary = await ensureCloudflared({ dataDir: options.dataDir, log });
  } catch (error) {
    return fail(`--tunnel: ${message(error)}`);
  }
  const guardian = guardianEntry();
  if (!guardian) return fail("--tunnel: the connector guardian is missing from this install");
  return { access, binary, guardian, origin: createTunnelOrigin(), account };
}
