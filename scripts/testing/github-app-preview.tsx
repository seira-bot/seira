import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BotSettingsDialog } from "../../src/components/BotSettingsDialog";
import { PluginsPanel } from "../../src/components/PluginsPanel";
import { openBotSettings } from "../../src/components/bot-panel/panel-link";
import { StoreProvider, useStore } from "../../src/state/store";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import { applySkin, readSkin } from "../../src/lib/skins";
import "../../src/styles.css";

setAnalyticsEnabled(false);
applySkin(readSkin());

declare global {
  interface Window { __githubFixture?: { openBot(botId: string, page?: "apps" | "github"): void } }
}

function Fixture() {
  const { state, dispatch } = useStore();
  const bot = state.bots.find((candidate) => candidate.id === state.selectedId) ?? state.bots[0];
  useEffect(() => {
    window.__githubFixture = {
      openBot: (botId, page) => {
        dispatch({ type: "select", id: botId });
        openBotSettings(dispatch, "access", { botId, ...(page ? { page } : {}) });
      },
    };
  }, [dispatch]);
  return state.settingsOpen && bot
    ? <div className="relative h-screen"><BotSettingsDialog key={bot.id} bot={bot} overlay /></div>
    : <PluginsPanel />;
}

createRoot(document.getElementById("root")!).render(<StoreProvider><Fixture /></StoreProvider>);
