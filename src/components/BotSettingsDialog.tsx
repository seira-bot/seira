import { useEffect, useRef, useState } from "react";

import { useStore, type Bot, type BotSettingsSection } from "@/state/store";
import { BOT_SECTIONS, appSearchPhase } from "./bot-settings/sections";
import { useBotApps } from "./bot-settings/useBotApps";
import { useBotSettingsDerived } from "./bot-settings/useBotSettingsDerived";
import { OverviewSection } from "./bot-settings/OverviewSection";
import { IdentitySection } from "./bot-settings/IdentitySection";
import { SlackSection } from "./bot-settings/SlackSection";
import { useSlackManagementUrl } from "./bot-settings/useSlackManagement";
import { SoulSection } from "./bot-settings/SoulSection";
import { SkillsSection } from "./bot-settings/SkillsSection";
import { MemorySection } from "./bot-settings/MemorySection";
import { RoutinesSection } from "./bot-settings/RoutinesSection";
import { AccessSection } from "./bot-settings/AccessSection";
import { ModelSection } from "./bot-settings/ModelSection";
import { PermissionsSection } from "./bot-settings/PermissionsSection";
import { VoiceSection } from "./bot-settings/VoiceSection";
import { HistorySection } from "./bot-settings/HistorySection";
import { UsageSection } from "./bot-settings/UsageSection";
import { VisibilitySection } from "./bot-settings/VisibilitySection";
import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { AdvancedPanel } from "./bot-panel/AdvancedPanel";
import { BotPanel } from "./bot-panel/PanelShell";
import { LibraryTab } from "./bot-panel/LibraryTab";
import type { SimplePageId } from "./bot-panel/page-registry";
import { BOT_PANEL_ID, sidePanelCls } from "./bot-panel/side-panel";
import { HistoryRollbackDialog, useBotHistory, useBotOverview } from "./bot-settings/useBotOverview";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useTeamName } from "./bot-access/ShareBotButton";

/** Where the Library's memory, skills and folder rows lead in Advanced settings. */
const LIBRARY_LINKS: Partial<Record<SimplePageId, BotSettingsSection>> = { memory: "memory", skills: "skills", folder: "access" };

export function BotSettingsDialog({ bot, overlay = false }: {
  bot: Bot;
  overlay?: boolean;
}) {
  const { state, dispatch } = useStore();
  const section = state.botSettingsSection;
  const derived = useBotSettingsDerived(bot);
  const dialogRef = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const collapsed = !state.botSettingsExpandAccordion;
  const q = query.trim().toLowerCase();
  const advanced = useAdvancedMode();
  const simpleView = !advanced;
  const linkedSection = !collapsed && !state.botSettingsExpandRemembered ? section : null;
  const slackUrl = useSlackManagementUrl(bot.id);
  const ownerOrAdmin = useOwnerOrAdmin();
  const teamName = useTeamName();
  const sections = BOT_SECTIONS
    .filter((entry) => entry.id !== "slack" || slackUrl !== null)
    .filter((entry) => entry.id !== "visibility" || (!window.ogb && ownerOrAdmin === true && !teamName));
  // Connected apps load only once the person searches; their names find the Access section.
  const searchApps = useBotApps(bot, q !== "");
  const appNames = searchApps.apps.flatMap((app) => [app.label, app.slug]);

  const { overview, overviewError, prompt, promptError } = useBotOverview(bot, {
    overview: section === "overview" && !simpleView,
    prompt: section === "overview" && !simpleView,
  });
  const history = useBotHistory(bot, section === "history" && !simpleView);

  useEffect(() => {
    if (collapsed) return;
    if (q) { setQuery(""); return; }
    dialogRef.current?.querySelector(`[data-bot-settings-section="${section}"]`)
      ?.scrollIntoView({ block: "start" });
  }, [collapsed, section, q]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.focus();

    const onKey = (event: KeyboardEvent) => {
      const nested = dialog?.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');
      if (nested && nested.getClientRects().length > 0) return;
      // BotInstructionsDialog portals to document.body: a key pressed with focus outside this dialog is not ours.
      if (dialog && event.target instanceof Node && !dialog.contains(event.target)) return;
      // A popover or field inside that already handled this Escape keeps the panel open.
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        dispatch({ type: "toggleSettings", open: false });
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [dispatch]);

  const renderSectionBody = (id: (typeof BOT_SECTIONS)[number]["id"]) => {
    switch (id) {
      case "overview":
        return overview === null && overviewError ? (
          <div className="rounded-xl bg-card p-4 text-[13px] text-ink-secondary">{t("botSettings.overviewFailed")}</div>
        ) : (
          <OverviewSection
            overview={overview}
            refreshError={overview !== null && overviewError}
            prompt={prompt}
            promptError={promptError}
            onOpen={(target) => dispatch({ type: "toggleSettings", open: true, section: target })}
            onSetup={derived.canCoordinate && !bot.busy ? () => {
              dispatch({ type: "toggleSettings", open: false });
              dispatch({ type: "send", botId: bot.id, text: "/setup", threadId: bot.threadId });
            } : undefined}
          />
        );
      case "identity":
        return (
          <IdentitySection
            bot={bot}
            patch={derived.patch}
            activeState={derived.activeState}
            mascotMotion={derived.mascotMotion}
          />
        );
      case "soul":
        return <SoulSection bot={bot} patch={derived.patch} />;
      case "slack":
        return slackUrl ? <SlackSection managementUrl={slackUrl} /> : null;
      case "skills":
        return <SkillsSection bot={bot} />;
      case "memory":
        return <MemorySection bot={bot} active={!collapsed && section === "memory"} onToggle={(enabled) => derived.patch({ memoryEnabled: enabled })} />;
      case "library":
        return <LibraryTab bot={bot} onOpen={(page) => dispatch({ type: "toggleSettings", open: true, section: LIBRARY_LINKS[page] ?? "overview" })} />;
      case "routines":
        return <RoutinesSection bot={bot} routines={derived.botRoutines} runs={state.routineRuns} />;
      case "access":
        return <AccessSection bot={bot} derived={derived} />;
      case "model":
        return <ModelSection bot={bot} />;
      case "permissions":
        return <PermissionsSection bot={bot} derived={derived} />;
      case "voice":
        return <VoiceSection bot={bot} derived={derived} />;
      case "visibility":
        return <VisibilitySection bot={bot} />;
      case "history":
        return history.rows === null && history.error ? (
          <div className="rounded-xl bg-card p-4 text-[13px] text-ink-secondary">{t("botSettings.historyFailed")}</div>
        ) : (
          <HistorySection
            bot={bot}
            rows={history.rows}
            refreshError={history.rows !== null && history.error}
            onRollback={history.requestRollback}
            rollingBack={history.rollingBack || !history.revision}
          />
        );
      case "usage":
        return <UsageSection bot={bot} />;
      default:
        return null;
    }
  };

  return (
    <>
      <aside
        ref={dialogRef}
        id={simpleView ? BOT_PANEL_ID : undefined}
        role="dialog"
        aria-labelledby="bot-settings-title"
        tabIndex={-1}
        className={sidePanelCls(overlay, simpleView)}
      >
        {simpleView ? (
          <BotPanel
            bot={bot}
            derived={derived}
            linkedSection={linkedSection}
            onClose={() => dispatch({ type: "toggleSettings", open: false })}
          />
        ) : (
          <AdvancedPanel
            bot={bot}
            derived={derived}
            sections={sections}
            query={query}
            appNames={appNames}
            appsPhase={appSearchPhase(searchApps)}
            open={collapsed ? null : section}
            onQuery={(value) => {
              setQuery(value);
              dispatch({ type: "toggleSettings", open: true });
            }}
            onToggle={(id) => {
              if (section === id && !collapsed) {
                dispatch({ type: "toggleSettings", open: true });
                return;
              }
              dispatch({ type: "toggleSettings", open: true, section: id });
            }}
            onOpenSection={(id) => dispatch({ type: "toggleSettings", open: true, section: id })}
            renderBody={renderSectionBody}
            onClose={() => dispatch({ type: "toggleSettings", open: false })}
          />
        )}
      </aside>
      <HistoryRollbackDialog history={history} returnFocusRef={dialogRef} />
    </>
  );
}
