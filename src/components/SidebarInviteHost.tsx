import { useState, type ReactNode } from "react";
import { useMayInvite } from "@/lib/invite-access";
import { InviteDialog } from "./lazy-screens";

/** The sidebar's two Invite entries and the one dialog they open. The handlers are absent where inviting is not offered. */
export function useInviteHost(): { onBot: ((botId: string) => void) | undefined; onDepartment: ((name: string) => void) | undefined; dialog: ReactNode } {
  const mayInvite = useMayInvite();
  const [to, setTo] = useState<{ departments?: string[]; bots?: string[] } | null>(null);
  return {
    onBot: mayInvite ? (botId) => setTo({ bots: [botId] }) : undefined,
    onDepartment: mayInvite ? (name) => setTo({ departments: [name] }) : undefined,
    dialog: to !== null ? <InviteDialog open preset={to} onClose={() => setTo(null)} /> : null,
  };
}
