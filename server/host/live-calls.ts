import type { ApprovalMode } from "../../shared/approval-mode.ts";
import type { ProviderInstance } from "../contracts.ts";
import type { sinceFreshStart } from "../fresh-start.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import { liveHistoryFrom, LiveSessionError, type LiveBot, type LiveHistoryMessage } from "../live-call.ts";
import type { LiveSessionWiringInput } from "../live-session-wiring.ts";
import type { BotRecord, Store } from "../store.ts";
import type { generateThreadTitle } from "../thread-title-generate.ts";

export interface LiveCallHostDeps {
  store: Pick<Store, "bot" | "activePath" | "projectBotForTask" | "taskByThread" | "appendMessage">;
  registry: Pick<ProviderRegistry, "get">;
  taskFolders(bot: BotRecord, threadId: string, instance: { instanceId: string; driverKind: string }): { privateWorkspace: string; pinnedCwd: string | null };
  toolScopeForTurn(botId: string): unknown;
  approvalModeForTurn(bot: BotRecord, peerInitiated: boolean, threadId: string): ApprovalMode;
  cloudGuestDriven(threadId: string): boolean;
  botApiThread(threadId: string): boolean;
  threadTitleGate(bot: Pick<BotRecord, "modelSelection">): { ok: true; instance: ProviderInstance } | { ok: false; refusal: string };
  generateThreadTitle: typeof generateThreadTitle;
  sinceFreshStart: typeof sinceFreshStart;
}

export function createLiveCallHost(deps: LiveCallHostDeps): {
  liveBotFor(botId: string): LiveBot;
  liveHistoryFor(threadId: string): LiveHistoryMessage[];
  liveCallTitle(botId: string, threadId: string, excerpt: string): Promise<string | null> | null;
  liveCodexFor: NonNullable<LiveSessionWiringInput["codexLive"]>;
  postLiveCallAnswer(input: { botId: string; threadId: string; text: string }): void;
} {
  function liveBotFor(botId: string): LiveBot {
    const bot = deps.store.bot(botId);
    if (!bot) throw new LiveSessionError("That bot no longer exists.", 404);
    return { name: bot.name, title: bot.title, description: bot.description };
  }
  function liveHistoryFor(threadId: string): LiveHistoryMessage[] {
    return liveHistoryFrom(deps.sinceFreshStart(deps.store.activePath(threadId)));
  }
  /** On the bot's own engine, which already saw the requests, so nothing new reaches OpenAI. */
  function liveCallTitle(botId: string, threadId: string, excerpt: string): Promise<string | null> | null {
    const bot = deps.store.projectBotForTask(botId, threadId);
    if (!bot) return null;
    const gate = deps.threadTitleGate(bot);
    return gate.ok ? deps.generateThreadTitle(gate.instance, excerpt, "call") : null;
  }
  function liveCodexFor(botId: string, threadId: string): ReturnType<NonNullable<LiveSessionWiringInput["codexLive"]>> {
    const bot = deps.store.projectBotForTask(botId, threadId);
    const instance = bot ? deps.registry.get(bot.modelSelection.instanceId) : undefined;
    if (!bot || !instance || instance.driverKind !== "codex" || !instance.startLiveVoice) return null;
    const { privateWorkspace, pinnedCwd } = deps.taskFolders(bot, threadId, instance);
    const cwd = pinnedCwd ?? privateWorkspace;
    const toolScoped = (() => { try { return deps.toolScopeForTurn(bot.id) !== undefined; } catch { return true; } })();
    return {
      startLiveVoice: (input) => instance.startLiveVoice!(input), cwd, approvalMode: deps.approvalModeForTurn(bot, false, threadId), botId: bot.id, model: bot.modelSelection.model || null,
      toolScoped, guestConfined: deps.cloudGuestDriven(threadId) || deps.botApiThread(threadId),
    };
  }
  function postLiveCallAnswer({ botId, threadId, text }: { botId: string; threadId: string; text: string }): void {
    if (deps.store.taskByThread(botId, threadId)) deps.store.appendMessage(threadId, { role: "bot", kind: "text", text });
  }
  return { liveBotFor, liveHistoryFor, liveCallTitle, liveCodexFor, postLiveCallAnswer };
}
