const MAX_DISPLAY_NAME = 128;

export function accountDisplayName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (value.length < 1 || value.length > MAX_DISPLAY_NAME) return undefined;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 32 || codePoint === 127) return undefined;
  }
  return value;
}

/** Reads `state.val.displayName` of a Composio connected account. */
export function accountStateDisplayName(state: unknown): string | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const val = (state as { val?: unknown }).val;
  if (typeof val !== "object" || val === null) return undefined;
  return accountDisplayName((val as { displayName?: unknown }).displayName);
}

const isActive = (status: string) => /^active$/i.test(status);
const nameKey = (name: string) => name.toLowerCase();

interface IdentityAccount {
  id: string;
  status: string;
  displayName?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Maps each newer active account to the oldest active account with the same provider name. */
export function markDuplicateAccounts<T extends IdentityAccount>(accounts: T[]): Map<string, string> {
  const groups = new Map<string, Array<{ account: T; order: number }>>();
  accounts.forEach((account, order) => {
    if (!isActive(account.status) || !account.displayName) return;
    const key = nameKey(account.displayName);
    const group = groups.get(key) ?? [];
    group.push({ account, order });
    groups.set(key, group);
  });
  const duplicates = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) =>
      (a.account.createdAt ?? "").localeCompare(b.account.createdAt ?? "")
      || (a.account.updatedAt ?? "").localeCompare(b.account.updatedAt ?? "")
      || a.order - b.order);
    const [original, ...rest] = group;
    for (const { account } of rest) duplicates.set(account.id, original!.account.id);
  }
  return duplicates;
}

/** Revoking a Google token ends every grant of that user for the OAuth client, so a twin connection dies too.
 *  `others` are the accounts of the same toolkit. */
export function revokesProviderGrant(
  target: { id: string; displayName?: string },
  others: Array<{ id: string; status: string; displayName?: string }>,
): boolean {
  const live = others.filter((other) => other.id !== target.id && isActive(other.status));
  if (live.length === 0) return true;
  if (!target.displayName) return false;
  const targetKey = nameKey(target.displayName);
  return live.every((other) => other.displayName !== undefined && nameKey(other.displayName) !== targetKey);
}
