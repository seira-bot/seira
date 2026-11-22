import type { ActiveCall } from "@/lib/call-session";
import type { AppState, Bot } from "@/state/store";

export const atlas: Bot = {
  id: "atlas", threadId: "thread-atlas", name: "Atlas", title: "", description: "", notifications: true, color: "green",
  unread: false, messages: [], voice: "marin", modelSelection: { instanceId: "claude", model: "test" },
};

export function activeCall(patch: Partial<ActiveCall> = {}): ActiveCall {
  return {
    mode: "turns", botId: "atlas", stage: "connected", presence: "listening", startedAt: 0, muted: false, text: "", textIsHeard: false,
    note: null, pushToTalk: false, canInterrupt: false, minimized: false, captions: [], speechError: null, ...patch,
  };
}

export const turnsConfig = (provider: string | undefined, extra: Partial<AppState["config"]> = {}) =>
  ({ tts: { configured: true, ready: true, voice: "marin", ...(provider ? { provider } : {}) }, live: { configured: true, voice: "marin", readTypedReplies: true, idleMinutes: 5 }, ...extra }) as unknown as AppState["config"];
