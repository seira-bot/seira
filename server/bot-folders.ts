import type { DepartmentFolders } from "./department-folders.ts";
import { type EffectiveFolderAccess, effectiveFolderAccess, type FolderAccess, resolveGrantsForTurn, type TurnFolders } from "./folder-access.ts";
import { sectionKey } from "./store.ts";

export interface BotFolders {
  /** The bot's folders with their source, or null for an unknown bot. */
  effective(botId: string): EffectiveFolderAccess | null;
  /** The folders a turn of this bot may use now, checked again on disk; null when the bot has no folder setting. */
  forTurn(botId: string): TurnFolders | null;
}

export interface BotFoldersDeps {
  bot(botId: string): { folderAccess?: FolderAccess; section?: string } | null | undefined;
  departments: Pick<DepartmentFolders, "get">;
  dataDir: string;
  log?: (line: string) => void;
}

export function createBotFolders(deps: BotFoldersDeps): BotFolders {
  const effective = (botId: string): EffectiveFolderAccess | null => {
    const bot = deps.bot(botId);
    if (!bot) return null;
    const section = sectionKey(bot.section);
    return effectiveFolderAccess(bot.folderAccess, section ? { name: section, access: deps.departments.get(section) } : null);
  };
  return {
    effective,
    forTurn: (botId) => {
      const access = effective(botId);
      return access ? resolveGrantsForTurn(access, { dataDir: deps.dataDir, log: deps.log }) : null;
    },
  };
}
