import { useEffect, useState } from "react";
import { AppWindow, Bot as BotIcon, Cloud, Download, Mail, Smartphone, Sparkles, Users, type LucideIcon } from "lucide-react";

import { track } from "@/lib/analytics";
import { INTRO_CHIPS, myDefaultBot, setupSteps, useViewerEmail, type IntroChip, type SetupStep } from "@/lib/default-bot";
import { t } from "@/lib/i18n";
import { phonePairingSettingsAction } from "@/lib/phone-pairing";
import { isOwnerOrAdmin, readSessionState } from "@/lib/session";
import type { LocaleKey } from "@/locales";
import { api, useStore, type Action, type Bot, type InstanceInfo, type Message } from "@/state/store";
import { returnFocusToComposer } from "./AskCard";
import { engineReady } from "./EngineLibrary";
import { IntroConnectAi } from "./ConnectAiInPlace";

const STEPS: Record<SetupStep, { label: LocaleKey; icon: LucideIcon }> = {
  team: { label: "helperIntro.step.team", icon: Users },
  ai: { label: "helperIntro.step.ai", icon: Sparkles },
  bots: { label: "helperIntro.step.bots", icon: BotIcon },
  apps: { label: "helperIntro.step.apps", icon: AppWindow },
  phone: { label: "helperIntro.step.phone", icon: Smartphone },
  cloud: { label: "helperIntro.step.cloud", icon: Cloud },
};

/** Each step opens the app's own flow for it. */
export function setupAction(step: Exclude<SetupStep, "team">): Action {
  switch (step) {
    case "ai": return { type: "toggleAppSettings", open: true, section: "engines" };
    case "bots": return { type: "newBot" };
    case "apps": return { type: "togglePlugins", open: true, surface: "apps" };
    case "phone": return phonePairingSettingsAction();
    case "cloud": return { type: "openCloudAdd", source: "app_onboarding" };
  }
}

/** Seira leads here and its AI can run agent tools, which a team suggestion needs. */
export function seiraSuggestsTeams(bot: Pick<Bot, "chiefOfStaff" | "modelSelection"> | undefined, instances: readonly InstanceInfo[], admin: boolean): boolean {
  return Boolean(admin && bot?.chiefOfStaff && instances.find((instance) => instance.instanceId === bot.modelSelection?.instanceId)?.capabilities?.agentsMcp === true);
}

/** Only an owner or admin can create the suggested team, so only they see the chip. */
export function useIsAdmin(): boolean {
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    let alive = true;
    void readSessionState().then((session) => {
      if (alive) setAdmin(isOwnerOrAdmin(session));
    });
    return () => { alive = false; };
  }, []);
  return admin;
}

/** Seira's question about the person's work, which the server posts and the chat shows. */
function useAskForTeam(botId: string | undefined, threadId: string | undefined): () => void {
  const { dispatch } = useStore();
  return () => {
    if (!botId || !threadId) return;
    void api<{ message?: Message }>(`/api/bots/${encodeURIComponent(botId)}/team-ask`, { method: "POST", body: JSON.stringify({ threadId }) })
      .then((reply) => {
        if (reply?.message) dispatch({ type: "messageAdded", threadId, message: reply.message });
        returnFocusToComposer();
      }, () => undefined);
  };
}

/** What is left to set up, under Seira's intro on a new install (Advanced mode). */
export function HelperSetup() {
  const { state, dispatch } = useStore();
  const seira = myDefaultBot(state.bots, useViewerEmail());
  const askForTeam = useAskForTeam(seira?.id, seira?.threadId);
  const admin = useIsAdmin();
  const steps = setupSteps({
    agentTools: seiraSuggestsTeams(seira, state.instances, admin),
    aiReady: state.instances.some(engineReady),
    ownBots: state.bots.filter((bot) => !bot.hidden && !bot.defaultBot).length,
    onCloud: state.config?.cloudHome === true,
    team: Boolean(state.config?.team),
    remote: typeof window !== "undefined" && window.ogb?.remoteClient?.active === true,
  });
  if (!steps.length) return null;
  return (
    <div role="group" aria-label={t("helperIntro.setup")} data-helper-setup="" className="flex max-w-full flex-col items-start gap-1.5">
      <span className="text-[13px] text-ink-secondary">{t("helperIntro.setup")}</span>
      <div className="flex flex-wrap gap-1.5">
        {steps.map((step) => {
          const { label, icon: Icon } = STEPS[step];
          return (
            <button key={step} type="button" data-helper-step={step} onClick={() => {
              if (step === "team") return askForTeam();
              if (step === "cloud") track("onboarding_cloud", { action: "start_trial" });
              dispatch(setupAction(step));
            }}
              className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-accent/20">
              <Icon size={14} aria-hidden="true" className="text-accent" />{t(label)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const CHIPS: Record<IntroChip, { label: LocaleKey; icon: LucideIcon }> = {
  team: { label: "helperIntro.chip.team", icon: Users },
  ai: { label: "helperIntro.chip.ai", icon: Sparkles },
  apps: { label: "helperIntro.chip.mail", icon: Mail },
  import: { label: "helperIntro.chip.skills", icon: Download },
  phone: { label: "helperIntro.chip.phone", icon: Smartphone },
  cloud: { label: "helperIntro.chip.cloud", icon: Cloud },
};

/** Each chip opens the app's own flow for it; Connect an AI opens its dialog in place (IntroChips). */
export function chipAction(chip: Exclude<IntroChip, "ai" | "team">): Action {
  switch (chip) {
    case "apps": return { type: "togglePlugins", open: true, surface: "apps" };
    case "import": return { type: "toggleAppSettings", open: true, section: "import" };
    case "phone": return phonePairingSettingsAction();
    case "cloud": return { type: "openCloudAdd", source: "app_onboarding" };
  }
}

/** What is still missing, as chips under Seira's follow-up (Simple mode): at most INTRO_CHIPS, and one that was tapped
 * leaves for the next. */
export function IntroChips({ chips, botId, threadId }: { chips: readonly IntroChip[]; botId?: string; threadId?: string }) {
  const { dispatch } = useStore();
  const askForTeam = useAskForTeam(botId, threadId);
  const [tapped, setTapped] = useState<ReadonlySet<IntroChip>>(new Set());
  const [connecting, setConnecting] = useState(false);
  const shown = chips.filter((chip) => !tapped.has(chip)).slice(0, INTRO_CHIPS);
  const tap = (chip: IntroChip) => {
    setTapped((now) => new Set([...now, chip]));
    if (chip === "ai") return setConnecting(true);
    if (chip === "team") return askForTeam();
    if (chip === "cloud") track("onboarding_cloud", { action: "start_trial" });
    dispatch(chipAction(chip));
  };
  return (
    <>
      {shown.length > 0 && (
        <div role="group" aria-label={t("helperIntro.setup")} data-helper-setup="" className="animate-msg-in mt-1 flex max-w-full flex-wrap gap-2">
          {shown.map((chip) => {
            const { label, icon: Icon } = CHIPS[chip];
            return (
              <button key={chip} type="button" data-helper-step={chip} onClick={() => tap(chip)}
                className="inline-flex h-8 items-center gap-2 rounded-full border-[0.5px] border-ink/[0.08] bg-card px-3 text-[14px] leading-5 text-ink transition-colors hover:bg-raised-hover">
                <Icon size={16} aria-hidden="true" className="text-ink-secondary" />{t(label)}
              </button>
            );
          })}
        </div>
      )}
      {connecting && <IntroConnectAi onClose={() => setConnecting(false)} />}
    </>
  );
}
