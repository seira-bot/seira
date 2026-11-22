import { Check } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { accountDetail, accountName, cleanSignInAvailable, usesCleanSignIn } from "@/lib/connector-account-label";
import { needsReconnect, type ConnectorAccount } from "@/lib/connector-status";

export function ConnectorAccountRows({ accounts, service, reconnectId, busy, onReconnect, onDisconnect }: {
  accounts: ConnectorAccount[];
  service: string;
  reconnectId?: string;
  busy: boolean;
  onReconnect: (account: ConnectorAccount) => void;
  onDisconnect: (account: ConnectorAccount) => void;
}) {
  return (
    <div className="mt-1.5 space-y-0.5">
      {accounts.map((account, index) => {
        const active = /^active$/i.test(account.status);
        const reconnectable = needsReconnect(account) && account.id !== reconnectId;
        const name = accountName(account, index);
        const detail = accountDetail(account);
        const original = account.duplicateOf ? accounts.findIndex((other) => other.id === account.duplicateOf) : -1;
        return (
          <div key={account.id}>
            <div className="flex min-w-0 items-center gap-2 text-[12px] leading-5">
              {active ? <Check size={12} className="shrink-0 text-success" /> : <span className="size-3 shrink-0" />}
              <span className="min-w-0 truncate text-ink" title={`${name}${detail ? ` · ${detail}` : ""} · ${account.status.toLowerCase()}`}>
                {name}
                {detail && <span className="text-ink-secondary"> · {detail}</span>}
                <span className="text-ink-secondary"> · {account.status.toLowerCase()}</span>
              </span>
              {reconnectable && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onReconnect(account)}
                  className="ms-auto shrink-0 rounded-full px-2 text-[12px] font-medium leading-5 text-accent-text transition-colors hover:bg-raised-hover disabled:opacity-40"
                  aria-label={t("connectors.reconnectAria", { account: name, service })}
                >
                  {t("connectors.action.reconnect")}
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => onDisconnect(account)}
                className={cn("shrink-0 rounded-full px-2 text-[12px] font-medium leading-5 text-ink-secondary transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40", !reconnectable && "ms-auto")}
                aria-label={t("connectors.disconnectAria", { account: name, service })}
              >
                {t("connectors.disconnect")}
              </button>
            </div>
            {original >= 0 && (
              <div className="ps-5 text-[12px] leading-5 text-ink-secondary">
                {t("connectors.duplicateNote", { name: accountName(accounts[original]!, original) })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Which sign-in page the person will see, so they know how to pick the other account. */
export function AddAccountHint({ slug }: { slug: string }) {
  const clean = usesCleanSignIn(slug) && cleanSignInAvailable();
  return (
    <p className="mt-1.5 text-[12px] leading-5 text-ink-secondary">
      {t(clean ? "connectors.addHintCleanWindow" : "connectors.addHintBrowser")}
    </p>
  );
}
