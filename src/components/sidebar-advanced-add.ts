import type { Bot } from "@/state/store";

import { t } from "@/lib/i18n";
import { BOTS_SECTION_ID, CHANNELS_SECTION_ID } from "@/lib/sidebar-layout";

type AdvancedAddContext = {
  bots: Bot[];
  canAddBots: boolean;
  manageDepartments: boolean;
  newBot: () => void;
  newRoom: () => void;
  moveToTeam: (name: string) => void;
};

/** The "+" action of an Advanced section heading: a new bot, a new channel, or the department's bot list. */
export function advancedSectionAdd(ctx: AdvancedAddContext, id: string, sectionName: string | null | undefined): { onAdd?: () => void; addLabel?: string } {
  if (id === BOTS_SECTION_ID && ctx.canAddBots) return { onAdd: ctx.newBot, addLabel: t("sidebar.newBot") };
  if (id === CHANNELS_SECTION_ID) return { onAdd: ctx.newRoom, addLabel: t("sidebar.newChannel.title") };
  if (sectionName && ctx.manageDepartments) {
    const hasBots = ctx.bots.some((bot) => !bot.hidden && bot.section?.trim() === sectionName);
    return { onAdd: () => ctx.moveToTeam(sectionName), addLabel: t(hasBots ? "team.manageBotsIn" : "team.addBotsTo", { name: sectionName }) };
  }
  return {};
}
