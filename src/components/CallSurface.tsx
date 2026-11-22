import { openBot } from "@/state/thread-navigation";
import { setCallMinimized, useActiveCall } from "@/lib/call-session";
import { useShowThreads } from "@/lib/thread-preferences";
import { useStore } from "@/state/store";
import { CallFullView } from "./CallFullView";
import { CallPill } from "./CallPill";

/** The one call control in a chat: the full call view in the chat of the bot on the call, the call pill everywhere else and while it is minimized. */
export function CallSurface({ botId }: { botId?: string }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const call = useActiveCall();
  const bot = call ? state.bots.find((candidate) => candidate.id === call.botId) : undefined;
  if (!call || !bot) return null;
  if (!call.minimized && botId === call.botId) return <CallFullView bot={bot} call={call} />;
  return (
    <CallPill
      bot={bot}
      call={call}
      onOpen={() => {
        setCallMinimized(false);
        if (botId !== call.botId) openBot(dispatch, bot, showThreads);
      }}
    />
  );
}
