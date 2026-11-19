import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { t } from "@/lib/i18n";
import { plainErrorLine } from "@/lib/plain-error";
import { useStore, type AppState } from "@/state/store";
import { useTeamPeople } from "@/state/team-people";
import { engineReady } from "./EngineLibrary";
import { IntroConnectAi } from "./ConnectAiInPlace";
import { SeiraCharacter } from "./seira-character";

type Notice = NonNullable<AppState["notice"]>;

function NoAiNotice({ notice }: { notice: Notice }) {
  const { state, dispatch } = useStore();
  const member = useTeamPeople()?.admin === false;
  const [connecting, setConnecting] = useState(false);
  const ready = state.instances.some(engineReady);
  useEffect(() => { if (ready) dispatch({ type: "notice", notice: null }); }, [ready, dispatch]);
  return (
    <div className="w-full px-5">
      <div role="status" className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-hairline/40 bg-panel px-3 py-2 text-[13px] text-ink-secondary">
        <p className="min-w-0 flex-1 break-words">{notice.text}</p>
        {!member && (
          <button type="button" onClick={() => setConnecting(true)} className="shrink-0 rounded-full bg-accent/10 px-3 py-1 text-[13px] font-medium text-ink hover:bg-accent/20">
            {t("helperIntro.chip.ai")}
          </button>
        )}
        <button
          type="button"
          onClick={() => dispatch({ type: "notice", notice: null })}
          aria-label={t("chat.error.dismiss")}
          title={t("chat.error.dismiss")}
          className="shrink-0 rounded p-0.5 hover:bg-ink/10"
        >
          <X size={13} />
        </button>
      </div>
      {connecting && <IntroConnectAi onClose={() => setConnecting(false)} />}
    </div>
  );
}

export function ChatNotice({ notice }: { notice: AppState["notice"] }) {
  if (!notice) return null;
  if (notice.kind === "no-ai") return <NoAiNotice notice={notice} />;
  return (
    <div className="w-full px-5">
      <div role="status" className="mb-2 rounded-lg border border-hairline/40 bg-panel px-3 py-2 text-[13px] text-ink-secondary">
        {notice.kind === "note"
          ? notice.text
          : notice.kind === "steer-images"
            ? t("composer.queued.steerImagesHeld")
            : notice.kind === "bot-gone"
              ? t("thread.botGone")
              : notice.botName ? t("thread.goneShowing", { name: notice.botName }) : t("thread.gone")}
      </div>
    </div>
  );
}

export function ChatErrorBanner({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
  const member = useTeamPeople()?.admin === false;
  if (!message) return null;
  const plain = plainErrorLine(message) ?? (member && message.startsWith("forbidden:") ? t("serverError.chat.ownerOrAdmin") : undefined);
  return (
    <div className="w-full px-5">
      <div role="alert" className="mb-2 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
        <SeiraCharacter state="sad" size={28} className="-my-0.5" />
        <div className="min-w-0 flex-1 break-words">
          <p>{plain ?? message}</p>
          {plain && <details className="mt-1 text-[12px] text-ink-secondary"><summary className="cursor-pointer">{t("chat.error.details")}</summary><p dir="auto" className="mt-1 break-words">{message}</p></details>}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("chat.error.dismiss")}
          title={t("chat.error.dismiss")}
          className="shrink-0 rounded p-0.5 hover:bg-danger/10"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
