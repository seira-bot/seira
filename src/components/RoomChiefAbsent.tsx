import { useState } from "react";

import { t } from "@/lib/i18n";
import { api, useStore, type Group } from "@/state/store";
import { SeiraCharacter } from "./seira-character";

/** One line in a room its department's Chief of Staff is not in: why its work stops for approvals, and the way to add it. */
export function RoomChiefAbsent({ group, quiet = false }: { group: Group; quiet?: boolean }) {
  const { dispatch } = useStore();
  const [busy, setBusy] = useState(false);
  const chief = group.chiefAbsent;
  if (!chief) return null;
  const add = () => {
    setBusy(true);
    void api(`/api/groups/${group.id}`, { method: "PATCH", body: JSON.stringify({ memberIds: [...group.memberIds, chief.botId] }) })
      .catch((cause) => dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }))
      .finally(() => setBusy(false));
  };
  return (
    <div className={quiet ? "chat-column w-full px-5" : "flex w-full items-center gap-1 px-5"}>
      {!quiet && <SeiraCharacter state="attention" size={28} />}
      <p data-testid="room-chief-absent" className={quiet ? "mb-1 px-1 text-[12px] text-ink-tertiary" : "mb-1 min-w-0 flex-1 px-1 text-[12px] text-ink-secondary"}>
        {t("room.chiefAbsent.hint", { name: chief.name })}{" "}
        <button type="button" disabled={busy} onClick={add} className="cursor-pointer text-accent hover:underline disabled:cursor-default disabled:opacity-50">
          {t("room.chiefAbsent.add", { name: chief.name })}
        </button>
      </p>
    </div>
  );
}
