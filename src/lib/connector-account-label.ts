import { t } from "@/lib/i18n";
import type { ConnectorAccount } from "@/lib/connector-status";

type NamedAccount = Pick<ConnectorAccount, "alias" | "displayName">;

/** Apps whose Add account sign-in opens in a clean desktop window. Google blocks sign-in inside embedded windows. */
const CLEAN_SIGN_IN_TOOLKITS = new Set(["github"]);

export function usesCleanSignIn(slug: string): boolean {
  return CLEAN_SIGN_IN_TOOLKITS.has(slug);
}

/** The desktop bridge can open the clean window. */
export function cleanSignInAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.ogb?.openCleanSignInPage === "function";
}

/** What a person calls the account: their label, else the provider's name, else its position. Never the account id. */
export function accountName(account: NamedAccount, index: number): string {
  return account.alias?.trim() || account.displayName?.trim() || t("connectors.accountFallback", { number: index + 1 });
}

/** The provider's name, shown beside a label that says something else. */
export function accountDetail(account: NamedAccount): string | undefined {
  const label = account.alias?.trim();
  const name = account.displayName?.trim();
  return label && name && label.toLowerCase() !== name.toLowerCase() ? name : undefined;
}

/** The first account added since `before` that the status marks as a copy of an account in the list. */
export function findNewDuplicate(before: ReadonlySet<string>, accounts: readonly ConnectorAccount[]): ConnectorAccount | undefined {
  return accounts.find((account) => !before.has(account.id) && account.duplicateOf !== undefined
    && accounts.some((other) => other.id === account.duplicateOf));
}
