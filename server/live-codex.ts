import { liveBotName, liveIdentityLine, LIVE_STYLE_LINE, trimLiveHistory, type LiveBot, type LiveHistoryMessage } from "./live-call.ts";

/** The developer item for the voice model. Codex's own voice prompt hands the work over, so there is no delegation policy here. */
export function codexVoiceInstructions(bot: LiveBot, { cloudHome = false }: { cloudHome?: boolean } = {}): string {
  const name = liveBotName(bot);
  return [
    liveIdentityLine(bot, { cloudHome }),
    `To the user you are one assistant, ${name}, and you speak in the first person. Say "I" about everything you do.`,
    "Never mention a backend, a hand-off, a voice layer, or another system or model doing the work, and never say you are only a voice.",
    LIVE_STYLE_LINE,
    "Never say that an action happened until the result reports it.",
    "When a permission question comes up, read it clearly and wait for a clear yes or no. Never answer it yourself.",
    "Never end the call, or offer to end it, on your own.",
  ].join("\n");
}

/** Instructions for the Codex model that does the work behind the voice. */
export function codexWorkInstructions(bot: LiveBot): string {
  return [
    `You work for ${liveBotName(bot)} during a voice call. The person hears your final answer read aloud.`,
    "End each turn with a short answer that is easy to speak, in plain sentences.",
    "Use no Markdown, code blocks, tables, long lists, or file paths unless the person asks for them.",
  ].join("\n");
}

export function codexCallHistory(history: LiveHistoryMessage[]): Array<{ role: "user" | "assistant"; text: string }> {
  return trimLiveHistory(history);
}
