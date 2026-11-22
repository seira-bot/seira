import type { LocaleKey } from "@/locales";
import { t } from "./i18n";

export function disconnectAccountConfirmation(
  service: string,
  account: { alias?: string; displayName?: string },
  name: string,
) {
  const identity = account.alias && account.displayName && account.displayName.toLowerCase() !== account.alias.toLowerCase()
    ? `“${account.alias}” (${account.displayName})` : `“${name}”`;
  return t("connectors.disconnectConfirm", { identity, service });
}

export type ConnectorSetup = "ready" | "needs-setup" | "service-unavailable";

export function connectorSetupNotice(state: {
  configured: boolean;
  stale: boolean;
  setup: ConnectorSetup | undefined;
  remoteClient: boolean;
}): { key: LocaleKey; tone: "info" | "warning" } | null {
  if (state.configured || state.stale) return null;
  if (state.setup === "needs-setup") {
    return { key: state.remoteClient ? "connectors.setupNeededRemote" : "connectors.setupNeeded", tone: "info" };
  }
  return { key: "connectors.notConfigured", tone: "warning" };
}
