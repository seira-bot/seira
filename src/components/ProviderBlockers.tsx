import { useState } from "react";
import { X } from "lucide-react";
import { ApiError, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { providerUsesOf, type ProviderUse } from "../../shared/provider-uses";
import { ConfirmDialog } from "./ConfirmDialog";

/** What a refused Hide or Remove says still uses the provider; empty for any other failure. */
export const blockedUses = (cause: unknown): ProviderUse[] => cause instanceof ApiError && cause.status === 409 ? providerUsesOf(cause.body) : [];

export function providerUseLabel(use: ProviderUse): string {
  switch (use.kind) {
    case "default": return t("provider.use.default");
    case "other": return t("provider.use.other", { count: String(use.count) });
    case "bot": return t("provider.use.bot", { bot: use.botName });
    case "backup": return t("provider.use.backup", { bot: use.botName });
    case "running": return t("provider.use.running", { bot: use.botName });
    case "conversation": return use.title
      ? t("provider.use.conversation", { bot: use.botName, title: use.title })
      : t("provider.use.conversationUntitled", { bot: use.botName });
  }
}

const SHOWN = 6;

/** The uses that keep a provider from being hidden or removed, each with a way to change it. `hideAnyway` is given for
 * Hide only. */
export function ProviderBlockers({ name, uses, onClose, hideAnyway, className }: {
  name: string;
  uses: ProviderUse[];
  onClose: () => void;
  hideAnyway?: { run: () => void; busy: boolean };
  className?: string;
}) {
  const { dispatch } = useStore();
  const admin = useOwnerOrAdmin() === true;
  const [confirming, setConfirming] = useState(false);
  const working = uses.filter((use) => use.kind === "running");
  const open = (use: ProviderUse) => {
    onClose();
    if (use.kind === "other") return;
    if (use.kind === "default") dispatch({ type: "toggleAppSettings", open: true, section: "ai" });
    else if (use.kind === "bot" || use.kind === "backup") dispatch({ type: "toggleSettings", botId: use.botId, open: true, section: "model" });
    else {
      dispatch({ type: "toggleAppSettings", open: false });
      if (use.kind === "conversation") dispatch({ type: "switchTask", botId: use.botId, threadId: use.threadId });
      else dispatch({ type: "select", id: use.botId });
    }
  };
  const row = (use: ProviderUse, index: number) => {
    const label = providerUseLabel(use);
    return (
      <li key={index} data-provider-use={use.kind} className="flex items-center justify-between gap-2 py-0.5">
        <span className="min-w-0 break-words text-ink">{label}</span>
        {use.kind !== "other" && <button type="button" aria-label={t("provider.blocked.changeAria", { use: label })} onClick={() => open(use)}
          className="shrink-0 font-medium text-accent hover:underline">
          {t(use.kind === "running" ? "provider.blocked.open" : "provider.blocked.change")}
        </button>}
      </li>
    );
  };
  const reason = hideAnyway && (working.length > 0
    ? t("provider.hideAnywayWait", { bots: working.flatMap((use) => use.kind === "running" ? [use.botName] : []).join(", "), name })
    : !admin ? t("provider.hideAnywayAdmin") : null);
  return (
    <div data-provider-blockers role="alert" className={cn("flex flex-col gap-1.5 rounded-lg bg-card p-3 text-[12px] leading-snug text-ink-secondary shadow-lg", className)}>
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium text-ink">{t("provider.blocked.intro", { name })}</p>
        <button type="button" aria-label={t("common.close")} onClick={onClose} className="shrink-0 rounded p-0.5 text-ink-secondary hover:text-ink"><X size={13} aria-hidden="true" /></button>
      </div>
      <ul className="flex flex-col">{uses.slice(0, SHOWN).map(row)}</ul>
      {uses.length > SHOWN && (
        <details data-provider-uses-more>
          <summary className="cursor-pointer text-ink-secondary">{t("provider.blocked.more", { count: String(uses.length - SHOWN) })}</summary>
          <ul className="flex flex-col">{uses.slice(SHOWN).map((use, index) => row(use, SHOWN + index))}</ul>
        </details>
      )}
      {hideAnyway && (
        <>
          <button type="button" data-provider-hide-anyway disabled={reason !== null || hideAnyway.busy} onClick={() => setConfirming(true)}
            className="self-start rounded-lg px-2.5 py-1.5 font-medium text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50">
            {t("provider.hideAnyway")}
          </button>
          {reason && <p data-provider-hide-anyway-reason>{reason}</p>}
          <ConfirmDialog open={confirming} title={t("provider.hideAnywayTitle", { name })} body={t("provider.hideAnywayBody", { name })}
            confirmLabel={t("provider.hideAnyway")} tone="danger" pending={hideAnyway.busy}
            onCancel={() => setConfirming(false)} onConfirm={() => { setConfirming(false); hideAnyway.run(); }} />
        </>
      )}
    </div>
  );
}
