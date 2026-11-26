import { useState } from "react";
import { ChevronRight } from "lucide-react";

import { appSwitchPatch, botAppScope } from "@/lib/bot-app-access";
import { githubBotHint, githubOwnerName, githubTurnedOn, setGithubBotPolicy, useGithubApp } from "@/lib/github-app";
import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";
import { GITHUB_APP_SLUG } from "../../shared/github-app";
import { BotAvatar } from "./Avatar";
import { GrantDialog } from "./GrantDialog";
import { openBotSettings } from "./bot-panel/panel-link";
import { BotSwitch } from "./bot-panel/rows";

/** "Which bots can use GitHub?": one switch per bot. Only the person who connected GitHub can turn a bot on or off. */
export function GithubGrantPrompt({ bots, onDismiss }: { bots: Bot[]; onDismiss: () => void }) {
  const { dispatch } = useStore();
  const { status } = useGithubApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  if (!status) return null;
  const editable = status.canEdit && status.ownedByYou;
  const owner = githubOwnerName(status);
  const reason = t("github.dialogNote", { owner });

  const toggle = async (bot: Bot) => {
    if (!editable || busy) return;
    const on = status.bots[bot.id] === undefined;
    setBusy(bot.id);
    setFailed(false);
    try {
      await setGithubBotPolicy(bot.id, on ? githubTurnedOn() : null);
      if (on && botAppScope(bot, GITHUB_APP_SLUG) === null) {
        const patch = appSwitchPatch(bot, [GITHUB_APP_SLUG], GITHUB_APP_SLUG, true);
        if (Object.keys(patch).length > 0) dispatch({ type: "updateBot", botId: bot.id, patch });
      }
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  const openBot = (botId: string) => {
    onDismiss();
    dispatch({ type: "togglePlugins", open: false });
    openBotSettings(dispatch, "access", { botId, page: "github" });
  };

  return (
    <GrantDialog
      slug={GITHUB_APP_SLUG}
      title={editable ? t("apps.whichBots", { app: "GitHub" }) : t("github.botsThatCan")}
      onDismiss={onDismiss}
      note={editable ? undefined : reason}
      action={(
        <button type="button" onClick={onDismiss} className="rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:brightness-110">
          {editable ? t("common.done") : t("common.close")}
        </button>
      )}
    >
      {failed && <p role="alert" className="mb-1 text-[12px] text-danger">{t("github.error")}</p>}
      {bots.map((bot) => {
        const policy = status.bots[bot.id];
        return (
          <div key={bot.id} data-github-bot={bot.id} className="flex min-h-11 items-center gap-2.5 py-1">
            <BotAvatar bot={bot} size={24} animated={false} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-medium text-ink">{bot.name}</div>
              {policy && (
                <button type="button" onClick={() => openBot(bot.id)} className="mt-px inline-flex items-center gap-0.5 text-[12px] text-ink-secondary hover:text-ink">
                  {githubBotHint(policy)}
                  <ChevronRight size={12} className="text-ink-tertiary" aria-hidden="true" />
                </button>
              )}
            </div>
            <BotSwitch
              color={bot.color}
              checked={policy !== undefined}
              aria-label={t("botSettings.simple.appToggle", { name: bot.name, app: "GitHub" })}
              title={editable ? undefined : reason}
              disabled={!editable || busy !== null}
              onClick={() => void toggle(bot)}
              className="disabled:cursor-not-allowed"
            />
          </div>
        );
      })}
    </GrantDialog>
  );
}
