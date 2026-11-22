import { z } from "zod";
import {
  accountDisplayName,
  accountStateDisplayName,
  markDuplicateAccounts,
  revokesProviderGrant,
} from "../shared/connector-account-identity.ts";
import { ACCOUNT_ID } from "./composio-inventory-schema.ts";
import { canonicalToolkitSlug, type ConnectedAccountResponse } from "./composio-project.ts";
import type { ConnectedAccountSummary } from "./composio.ts";

export function applyAccountIdentity(
  summaries: Array<ConnectedAccountSummary & { createdAt?: string; updatedAt?: string }>,
  accounts: ConnectedAccountResponse[],
): void {
  const names = new Map(accounts.map((account) => [account.id, accountStateDisplayName(account.state)]));
  for (const summary of summaries) {
    const displayName = names.get(summary.id);
    if (displayName) summary.displayName = displayName;
  }
  const duplicates = markDuplicateAccounts(summaries);
  for (const summary of summaries) {
    const original = duplicates.get(summary.id);
    if (original) summary.duplicateOf = original;
  }
}

export const brokerAccountsSchema = z.array(z.object({
  id: z.string(),
  alias: z.string().optional(),
  status: z.string(),
  displayName: z.unknown().optional(),
  duplicateOf: z.unknown().optional(),
})).transform((accounts) => sanitizeBrokerAccounts(accounts));

export function publicAccount({ id, alias, status, displayName, duplicateOf }: ConnectedAccountSummary): ConnectedAccountSummary {
  const account: ConnectedAccountSummary = { id, status };
  if (alias) account.alias = alias;
  if (displayName) account.displayName = displayName;
  if (duplicateOf) account.duplicateOf = duplicateOf;
  return account;
}

/** Cleans the identity fields of an account list from a broker, which may be older than this app. */
export function sanitizeBrokerAccounts(
  accounts: Array<{ id: string; alias?: string; status: string; displayName?: unknown; duplicateOf?: unknown }>,
): ConnectedAccountSummary[] {
  const ids = new Set(accounts.map((account) => account.id));
  return accounts.map(({ id, alias, status, displayName, duplicateOf }) => {
    const account: ConnectedAccountSummary = { id, status };
    if (alias) account.alias = alias;
    const name = accountDisplayName(displayName);
    if (name) account.displayName = name;
    if (typeof duplicateOf === "string" && duplicateOf !== id && ACCOUNT_ID.test(duplicateOf) && ids.has(duplicateOf)) {
      account.duplicateOf = duplicateOf;
    }
    return account;
  });
}

/** Whether deleting `targetId` may also revoke the provider grant, given the user's accounts. */
export function revokeOnRemoval(accounts: ConnectedAccountResponse[], toolkit: string, targetId: string): boolean {
  const same = accounts.filter((account) =>
    account.id !== undefined && account.toolkit?.slug !== undefined && canonicalToolkitSlug(account.toolkit.slug) === toolkit);
  const describe = (account: ConnectedAccountResponse) => {
    const displayName = accountStateDisplayName(account.state);
    return { id: account.id ?? "", status: account.status ?? "UNKNOWN", ...(displayName ? { displayName } : {}) };
  };
  const target = same.find((account) => account.id === targetId);
  const identity = target ? describe(target) : { id: targetId };
  return revokesProviderGrant(identity, same.filter((account) => account.id !== targetId).map(describe));
}
