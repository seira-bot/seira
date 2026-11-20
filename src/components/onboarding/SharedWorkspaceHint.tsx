import { useId, useSyncExternalStore } from "react";
import { SeiraCharacter } from "@/components/seira-character";
import { t } from "@/lib/i18n";
import { hostedMember, type WelcomeViewer } from "@/lib/onboarding";
import { invitedToTeam, teamWelcomeAhead, useTeamWelcomeRecord } from "@/lib/team-welcome";
import { useStore } from "@/state/store";

const DISMISSED_KEY = "seira.onboarding.sharedWorkspaceHint";
let closedHere = false;
const listeners = new Set<() => void>();

export function sharedHintDismissed(): boolean {
  if (closedHere) return true;
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberDismissed(): void {
  closedHere = true;
  try {
    localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
  }
  for (const listener of listeners) listener();
}

function useSharedHintDismissed(): boolean {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, sharedHintDismissed, sharedHintDismissed);
}

/** Only for tests: a closed hint is module state. */
export function resetSharedHint(): void {
  closedHere = false;
}

/** A hosted member's note is on screen: after their team's welcome, until Got it, or while Settings replays it. */
export function useSharedHintOn(viewer: WelcomeViewer | null): boolean {
  const { state } = useStore();
  const team = state.config?.team ?? null;
  const invited = invitedToTeam(viewer);
  const teamWelcome = useTeamWelcomeRecord(team && invited ? team.id : null);
  const dismissed = useSharedHintDismissed();
  return hostedMember(viewer) && window.ogb?.remoteClient?.active !== true && !teamWelcomeAhead(invited, teamWelcome)
    && (!dismissed || state.welcomeOpen);
}

export function SharedWorkspaceHint({
  replay,
  onClose,
}: {
  replay: boolean;
  onClose: () => void;
}) {
  const dismissed = useSharedHintDismissed();
  const titleId = useId();
  if (dismissed && !replay) return null;
  const close = () => {
    rememberDismissed();
    onClose();
  };
  return (
    <aside
      aria-labelledby={titleId}
      className="fixed bottom-4 left-[calc(var(--rail-beside,0px)_+_1rem)] z-40 flex max-h-[calc(100dvh-32px)] w-[300px] max-w-[calc(100vw_-_var(--rail-beside,0px)_-_32px)] items-start gap-3 overflow-y-auto rounded-2xl border border-hairline/50 bg-panel p-3.5 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.6)]"
    >
      <div className="-my-1 shrink-0">
        <SeiraCharacter state="greet" size={48} />
      </div>
      <div className="min-w-0 flex-1">
        <h2 id={titleId} className="text-[14px] font-semibold text-ink">
          {t("onboarding.shared.title")}
        </h2>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{t("onboarding.shared.body")}</p>
        <button
          type="button"
          onClick={close}
          className="mt-2.5 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-transform duration-150 active:scale-[0.98]"
        >
          {t("onboarding.spot.gotIt")}
        </button>
      </div>
    </aside>
  );
}
