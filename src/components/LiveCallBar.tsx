import { ExternalLink, PhoneOff, RotateCcw, X } from "lucide-react";

import { t } from "@/lib/i18n";
import {
  dismissLiveNotice, isLiveCallRunning, takeLiveCallAction, useLiveMedia,
  type LiveCallAction, type LiveMediaState,
} from "@/lib/live-call-media";
import { api, liveCallFromFrame, nextLiveCallLookup, useStore, type Action, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import type { LiveCallState, LiveClient } from "../../shared/wire";
import { OpenSystemSettings } from "./OpenSystemSettings";

export type LiveCallBarView =
  | { kind: "remote"; title: string; callId: string }
  | { kind: "notice"; text: string; action: LiveCallAction | null; micSettings?: boolean };

const DEVICE_KEY = {
  ios: "call.live.device.ios",
  android: "call.live.device.android",
  desktop: "call.live.device.desktop",
  web: "call.live.device.web",
} as const satisfies Record<LiveClient, string>;

export function liveCallBarView({ bot, media, server }: {
  bot: { id: string; threadId: string; name: string };
  media: LiveMediaState;
  server: LiveCallState | null;
}): LiveCallBarView | null {
  const here = media.botId === bot.id && media.threadId === bot.threadId;
  if (here && (media.phase === "failed" || media.phase === "ended") && media.notice) {
    return { kind: "notice", text: media.notice, action: media.phase === "failed" ? media.action : null, ...(media.micSettings ? { micSettings: true } : {}) };
  }
  if (
    server && server.status !== "ending" && server.status !== "ended"
    && server.botId === bot.id && server.threadId === bot.threadId && server.callId !== media.callId
  ) {
    return { kind: "remote", title: t("call.live.onPhone", { name: bot.name, device: t(DEVICE_KEY[server.client]) }), callId: server.callId };
  }
  return null;
}

export function liveLineHeldElsewhere(media: LiveMediaState, server: LiveCallState | null): boolean {
  return Boolean(server && server.status !== "ended") && !isLiveCallRunning(media.phase);
}

export async function hangUpRemoteCall(
  callId: string,
  since: number,
  dispatch: (action: Action) => void,
  request: typeof api = api,
): Promise<void> {
  try {
    await request("/api/live/call/end", { method: "POST", body: JSON.stringify({ callId }) });
  } catch {
    try {
      const seq = nextLiveCallLookup();
      const answer = liveCallFromFrame(await request<unknown>("/api/live/call"));
      if (answer) dispatch({ type: "liveCallLookup", call: answer.call, since, seq });
    } catch {
    }
  }
}

export function LiveCallBar({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const media = useLiveMedia();
  const view = liveCallBarView({ bot, media, server: state.liveCall });

  if (!view) return null;
  const button = "flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium transition-colors";
  const frame = "pointer-events-auto mx-5 mb-2 flex items-center rounded-xl border bg-panel px-3 py-2 text-[13px] text-ink";

  if (view.kind === "notice") {
    const action = view.action === "open-in-browser"
      ? { label: t("call.live.openInBrowser"), Icon: ExternalLink }
      : view.action === "retry" ? { label: t("call.live.tryAgain"), Icon: RotateCcw } : null;
    return (
      <div role="status" className={cn(frame, "gap-2 border-hairline/60")}>
        <span className="min-w-0 flex-1 truncate" title={view.text}>{view.text}</span>
        {view.micSettings && <OpenSystemSettings pane="mic" />}
        {action && (
          <button type="button" aria-label={action.label} className={cn(button, "bg-raised hover:bg-raised-hover")} onClick={takeLiveCallAction}>
            <action.Icon className="size-3.5" /> <span className="hidden sm:inline">{action.label}</span>
          </button>
        )}
        <button type="button" aria-label={t("call.live.close")} className={cn(button, "text-ink-secondary hover:text-ink")} onClick={dismissLiveNotice}>
          <X className="size-3.5" />
        </button>
      </div>
    );
  }

  const callId = view.callId;
  return (
    <div role="status" className={cn(frame, "gap-2 border-success/40")}>
      <span className="size-2 shrink-0 rounded-full bg-success" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{view.title}</span>
      <button
        type="button"
        aria-label={t("call.live.hangUp")}
        className={cn(button, "bg-danger text-white hover:brightness-110")}
        onClick={() => void hangUpRemoteCall(callId, state.liveCallVersion, dispatch)}
      >
        <PhoneOff className="size-3.5" /> <span className="hidden sm:inline">{t("call.live.hangUp")}</span>
      </button>
    </div>
  );
}
