import { accountDisplayName, accountStateDisplayName, markDuplicateAccounts, revokesProviderGrant } from "../../../shared/connector-account-identity";
import { composioRequest, type ConnectedAccountResponse } from "./common";

export function applyAccountIdentity(
  summaries: Array<{ id: string; status: string; displayName?: string; duplicateOf?: string; createdAt?: string; updatedAt?: string }>,
  accounts: ConnectedAccountResponse[],
): void {
  const names = new Map(accounts.map((account) => [account.id, accountStateDisplayName(account.state)]));
  for (const summary of summaries) {
    const displayName = names.get(summary.id);
    if (displayName) summary.displayName = accountDisplayName(displayName)!;
  }
  const duplicates = markDuplicateAccounts(summaries);
  for (const summary of summaries) {
    const original = duplicates.get(summary.id);
    if (original) summary.duplicateOf = original;
  }
}

/** Whether deleting `targetId` may also revoke the provider grant, given the user's accounts of that toolkit. */
export function revokeOnRemoval(accounts: ConnectedAccountResponse[], slug: string, targetId: string): boolean {
  const same = accounts.filter((account) => account.id !== undefined && account.toolkit?.slug?.toLowerCase() === slug);
  const describe = (account: ConnectedAccountResponse) => {
    const displayName = accountStateDisplayName(account.state);
    return { id: account.id ?? "", status: account.status ?? "UNKNOWN", ...(displayName ? { displayName } : {}) };
  };
  const target = same.find((account) => account.id === targetId);
  const identity = target ? describe(target) : { id: targetId };
  return revokesProviderGrant(identity, same.filter((account) => account.id !== targetId).map(describe));
}

export function deleteConnectedAccount(env: Env, id: string, revoke: boolean) {
  return composioRequest(env, `/connected_accounts/${encodeURIComponent(id)}?revoke_on_delete=${revoke}`, { method: "DELETE" });
}
