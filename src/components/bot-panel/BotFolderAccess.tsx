import { useEffect, useState } from "react";

import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useDepartmentFolders, type FolderAccess } from "@/lib/folder-access";
import type { Bot } from "@/state/store";
import { FolderAccessEditor } from "../FolderAccessEditor";
import { useBotEditor } from "../bot-settings/BotEditorContext";
import { Card } from "./rows";

/** Which other folders one bot may use, for an admin. Not shown to anyone else, nor where this server sets no folders. */
export function BotFolderAccess({ bot, variant }: { bot: Pick<Bot, "id" | "section" | "folderAccess">; variant: "panel" | "card" }) {
  const admin = useOwnerOrAdmin() === true;
  const { request } = useBotEditor();
  const { data } = useDepartmentFolders(admin);
  const [saved, setSaved] = useState<{ access: FolderAccess | null } | null>(null);
  const known = JSON.stringify(bot.folderAccess ?? null);
  useEffect(() => setSaved(null), [known]);

  if (!admin || !data) return null;
  const section = bot.section?.trim();
  const body = data.setHere ? (
    <FolderAccessEditor
      subject="bot"
      enforcement={data.enforcement}
      access={saved ? saved.access : bot.folderAccess}
      department={section ? { name: section, access: data.departments[section] } : undefined}
      save={async (next) => {
        await request(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ folderAccess: next }) });
        setSaved({ access: next });
      }}
    />
  ) : (
    <div className="text-[13px] text-ink-secondary">{t("folderAccess.setElsewhere")}</div>
  );

  if (variant === "panel") {
    return (
      <Card label={t("folderAccess.title")} anchor="folder-access">
        <div className="px-3.5 py-3">{body}</div>
      </Card>
    );
  }
  return (
    <div className="rounded-xl bg-card p-4" data-testid="access-folder-access">
      <div className="text-[15px] font-medium text-ink">{t("folderAccess.title")}</div>
      <div className="mb-3 mt-0.5 text-[13px] text-ink-secondary">{t("folderAccess.description")}</div>
      {body}
    </div>
  );
}
