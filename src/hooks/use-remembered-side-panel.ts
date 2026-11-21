import { useEffect, useRef } from "react";
import type { Action, AppState } from "@/state/store";

/** Per device: the right-side panel (the bot's screen, the bot info panel or the bot panel) last left open in the chat view. */
export type RememberedSidePanel = "computer" | "inspector" | "bot";

const NO_PANEL = "none";

export const SIDE_PANEL_OPEN_KEY = "seira-side-panel-open";

export function rememberedSidePanel(): RememberedSidePanel | null {
  try {
    const panel = localStorage.getItem(SIDE_PANEL_OPEN_KEY);
    return panel === "computer" || panel === "inspector" || panel === "bot" ? panel : null;
  } catch {
    return null;
  }
}

export function hasRememberedSidePanelChoice(): boolean {
  try {
    return localStorage.getItem(SIDE_PANEL_OPEN_KEY) !== null;
  } catch {
    return false;
  }
}

export function rememberSidePanel(panel: RememberedSidePanel | null): void {
  try {
    localStorage.setItem(SIDE_PANEL_OPEN_KEY, panel ?? NO_PANEL);
  } catch {
    // Storage can be full or blocked; the panel still stays as it is for this session.
  }
}

export type SidePanelPlace = Pick<AppState, "activeView" | "computerOpen" | "inspectorOpen" | "settingsOpen" | "appSettingsOpen" | "pluginsOpen">;

/**
 * Keeps the bot's screen, bot info panel or bot panel open across restarts and views that close it (routines,
 * files, Settings, Plugins): whenever the chat view appears it opens the remembered panel, and it remembers
 * what the person leaves open there. Off in the phone layout, where a panel covers the chat.
 */
export function useRememberedSidePanel(
  place: SidePanelPlace,
  dispatch: (action: Action) => void,
  options: { enabled: boolean; inspector: boolean; botPanelByDefault?: boolean },
): void {
  const { activeView, computerOpen, inspectorOpen, settingsOpen, appSettingsOpen, pluginsOpen } = place;
  const { enabled, inspector, botPanelByDefault = false } = options;
  const wasShown = useRef(false);
  const lastOpen = useRef<RememberedSidePanel | null>(null);
  useEffect(() => {
    const shown = enabled && activeView === "chat" && !appSettingsOpen && !pluginsOpen;
    const arrived = shown && !wasShown.current;
    wasShown.current = shown;
    const open = computerOpen ? "computer" : inspectorOpen ? "inspector" : settingsOpen ? "bot" : null;
    if (!shown) {
      lastOpen.current = null;
      return;
    }
    if (arrived && !open) {
      const panel = rememberedSidePanel();
      if (panel === "computer") dispatch({ type: "toggleComputer", open: true });
      else if (panel === "inspector" && inspector) dispatch({ type: "toggleInspector", open: true });
      else if (panel === "bot") dispatch({ type: "toggleSettings", open: true });
      else if (botPanelByDefault && !hasRememberedSidePanelChoice()) dispatch({ type: "toggleSettings", open: true });
      return;
    }
    if (open) rememberSidePanel(open);
    else if (lastOpen.current) rememberSidePanel(null);
    lastOpen.current = open;
  }, [activeView, computerOpen, inspectorOpen, settingsOpen, appSettingsOpen, pluginsOpen, enabled, inspector, botPanelByDefault, dispatch]);
}
