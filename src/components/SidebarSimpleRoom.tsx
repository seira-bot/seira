import { Users } from "lucide-react";

import type { Bot } from "@/state/store";

import { BotAvatar } from "./Avatar";

/** The two member avatars of a Simple room row: 28px, overlapped, each cut against the row's colour. */
export function SimpleRoomStack({ members }: { members: Bot[] }) {
  const shown = members.slice(0, 2);
  return (
    <div data-room-stack="" className="flex w-10 shrink-0 items-center">
      {shown.length === 0 && <Users size={20} aria-hidden="true" className="ms-1 text-ink-secondary" />}
      {shown.map((member, index) => (
        <span key={member.id} className={index > 0 ? "-ms-2.5 flex rounded-full ring-2 ring-[var(--row)]" : "flex rounded-full ring-2 ring-[var(--row)]"}>
          <BotAvatar bot={member} state="happy" size={28} animated={false} />
        </span>
      ))}
    </div>
  );
}
