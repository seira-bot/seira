import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import type { CompanionState } from "../lib/companion-types";
import { CommandRow } from "./EngineSetup";

const NOTE = "mt-3 w-full rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-left text-[12px] leading-relaxed text-warning";

/** What to change when this computer's firewall may drop the phone's connection on the Wi-Fi route. */
export function PhoneFirewallNotes({ state, className }: { state: CompanionState; className?: string }) {
  const firewall = state.linuxFirewall;
  return (
    <>
      {state.publicNetwork && (
        <p role="note" className={cn(NOTE, className)}>
          {t("phone.code.publicNetwork", { network: state.publicNetwork })}
        </p>
      )}
      {firewall && (
        <div role="note" className={cn(NOTE, className)}>
          <p>{t(firewall.certain ? "phone.code.linuxFirewall.blocked" : "phone.code.linuxFirewall.mayBlock")}</p>
          <CommandRow command={firewall.command} actionLabel={t("phone.code.linuxFirewall.terminal")} compact />
        </div>
      )}
    </>
  );
}
