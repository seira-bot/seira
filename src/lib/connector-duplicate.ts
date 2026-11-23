import { findNewDuplicate } from "@/lib/connector-account-label";
import type { ConnectorStatus } from "@/lib/connector-status";

/** After an Add account sign-in, remove the new account when it is a copy of one the app already had. */
export async function removeNewDuplicate(options: {
  before: ConnectorStatus | undefined;
  after: ConnectorStatus | undefined;
  remove: (accountId: string) => Promise<unknown>;
}): Promise<boolean> {
  const known = new Set((options.before?.accounts ?? []).map((account) => account.id));
  const duplicate = findNewDuplicate(known, options.after?.accounts ?? []);
  if (!duplicate) return false;
  await options.remove(duplicate.id);
  return true;
}
