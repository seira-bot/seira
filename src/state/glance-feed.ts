import type { InboxRow, InboxView } from "../../shared/inbox";
import { GLANCE_LIMITS, type GlanceAct, type GlanceAsk, type GlanceBot, type GlanceFeed, type GlanceLabels } from "../../shared/glance";
import { toolLabel } from "@/components/ApprovalCard";
import { sidebarBotStatus } from "@/components/SidebarBotActivity";
import { workingThreadId } from "@/components/SidebarWorkingStep";
import { askOf, answerThread, choiceResponse, choicesOf, textOf } from "@/components/inbox/inbox-view";
import { t } from "@/lib/i18n";
import { sidebarStatus, turnNowPhrases } from "@/lib/live-activity";
import { SEIRA_COLORS } from "@/lib/mascot";
import { settleInboxRow } from "./inbox";
import { openThread, visibleMessages, type Action, type AppState, type Bot } from "./store";
import { turnLive } from "./turn-status";

export interface GlanceBotInput {
  botId: string;
  threadId: string;
  name: string;
  avatarUrl?: string | null;
  color?: string | null;
  status: { waiting: boolean; working: boolean; failed: boolean };
  /** The live step in plain words, when the bot is working and says one. */
  line: string | null;
  startedAt?: number | null;
}

export interface GlanceAskInput {
  botId: string;
  threadId: string;
  kind: GlanceAsk["kind"];
  requestId: string;
  title: string;
  choices: string[];
  canAlways: boolean;
  /** What the approval runs, whole; empty when it cannot be shown whole. */
  detail: string;
  at: number;
}

const AVATAR = /^\/api\/attachments\/[A-Za-z0-9_-]+\.(?:png|jpe?g|gif|webp)$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const ORDER = { needs: 0, question: 0, failed: 1, working: 2 } as const;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

export function glanceLabels(): GlanceLabels {
  return {
    glance: t("glance.title"),
    working: t("glance.working"),
    needsYou: t("glance.needsYou"),
    question: t("glance.question"),
    failed: t("glance.failed"),
    finished: t("glance.finished"),
    failedLine: t("glance.failedLine"),
    openChat: t("glance.openChat"),
    deny: t("glance.deny"),
    allowOnce: t("glance.allowOnce"),
    alwaysAllow: t("glance.alwaysAllow"),
    couldNotSend: t("glance.couldNotSend"),
    close: t("glance.close"),
  };
}

function askOfBot(asks: GlanceAskInput[]): GlanceAskInput | null {
  const oldest = (kind: GlanceAsk["kind"]) => asks.filter((ask) => ask.kind === kind).sort((a, b) => a.at - b.at)[0];
  return oldest("approval") ?? oldest("question") ?? null;
}

function glanceAsk(ask: GlanceAskInput): GlanceAsk {
  const one = ask.kind === "question" && ask.choices.length > 0 && ask.choices.length <= GLANCE_LIMITS.choices;
  return {
    kind: ask.kind,
    requestId: clip(ask.requestId, GLANCE_LIMITS.id),
    title: clip(ask.title, GLANCE_LIMITS.title),
    choices: one ? ask.choices.map((label, index) => ({ id: String(index), label: clip(label, GLANCE_LIMITS.choiceLabel) })) : [],
    canAlways: ask.kind === "approval" && ask.canAlways,
    detail: ask.kind === "approval" ? ask.detail : "",
  };
}

export function buildGlanceFeed(input: { bots: GlanceBotInput[]; asks: GlanceAskInput[]; labels: GlanceLabels; lang: string }): GlanceFeed {
  const { labels } = input;
  const bots: GlanceBot[] = [];
  for (const bot of input.bots) {
    const picked = askOfBot(input.asks.filter((ask) => ask.botId === bot.botId));
    const state = picked ? (picked.kind === "approval" ? "needs" : "question")
      : bot.status.waiting ? "needs" : bot.status.failed ? "failed" : bot.status.working ? "working" : null;
    if (!state) continue;
    const line = state === "working" ? bot.line ?? "" : "";
    bots.push({
      botId: clip(bot.botId, GLANCE_LIMITS.id),
      threadId: clip(picked?.threadId ?? bot.threadId, GLANCE_LIMITS.id),
      name: clip(bot.name, GLANCE_LIMITS.name),
      avatarUrl: bot.avatarUrl && AVATAR.test(bot.avatarUrl) ? bot.avatarUrl : null,
      color: bot.color && HEX.test(bot.color) ? bot.color : null,
      state,
      line: clip(line, GLANCE_LIMITS.line),
      startedAt: bot.startedAt ?? null,
      ask: picked ? glanceAsk(picked) : null,
    });
  }
  bots.sort((a, b) => ORDER[a.state] - ORDER[b.state]);
  return { version: 1, lang: input.lang, bots: bots.slice(0, GLANCE_LIMITS.bots), labels };
}

export function glanceBotInputs(bots: readonly Bot[], queued: AppState["pendingQueued"]): GlanceBotInput[] {
  return bots.map((bot) => {
    const status = sidebarBotStatus(bot, queued, visibleMessages(bot));
    const tasks = bot.tasks ?? [];
    const threadId = status.working ? workingThreadId(bot) : status.waiting ? (tasks.find((task) => task.activity === "waiting-on-you")?.threadId ?? bot.threadId) : bot.threadId;
    const live = status.working ? turnNowPhrases(sidebarStatus(turnLive(threadId).status))?.phrases[0] : undefined;
    return {
      botId: bot.id,
      threadId,
      name: bot.name,
      avatarUrl: bot.avatarUrl ?? null,
      color: SEIRA_COLORS[bot.color as keyof typeof SEIRA_COLORS] ?? null,
      status,
      line: live ?? null,
      startedAt: tasks.find((task) => task.threadId === threadId)?.turnStartedAt ?? bot.turnStartedAt ?? null,
    };
  });
}

/** Security: a clipped command could hide its tail, so a text that is empty, too long or not a plain tool approval is never sent. */
export function approvalDetail(row: InboxRow): string {
  const text = row.card?.tool ? textOf(row) : "";
  return text.length > 0 && text.length <= GLANCE_LIMITS.detail ? text : "";
}

const rowBotId = (row: InboxRow): string | undefined => row.origin?.botId ?? row.from.botId;

export function glanceAskInputs(view: InboxView | null, bots: readonly Bot[]): GlanceAskInput[] {
  const asks: GlanceAskInput[] = [];
  for (const row of view?.rows ?? []) {
    const kind = askOf(row);
    const card = row.card;
    const bot = bots.find((one) => one.id === rowBotId(row));
    if ((kind !== "approval" && kind !== "question") || !card?.requestId || !bot) continue;
    asks.push({
      botId: bot.id,
      threadId: row.origin?.threadId ?? bot.threadId,
      kind,
      requestId: card.requestId,
      title: kind === "approval" ? t("approval.card.namedWantsTo", { name: bot.name, action: toolLabel(card.tool) }) : textOf(row),
      choices: kind === "question" ? choicesOf(row) : [],
      canAlways: kind === "approval" && Boolean(card.allowKey || card.allowSession),
      detail: kind === "approval" ? approvalDetail(row) : "",
      at: row.at,
    });
  }
  return asks;
}

export interface GlanceActDeps {
  dispatch: (action: Action) => void;
  getState: () => AppState;
  getInbox: () => InboxView | null;
  showThreads: () => boolean;
}

const SEND_WAIT_MS = 20_000;

type Decision = Extract<Action, { type: "decideRequest" }>;

export function glanceActHandler(deps: GlanceActDeps): (act: GlanceAct) => Promise<boolean> {
  const send = (action: Omit<Decision, "type" | "onSent" | "onError">) =>
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), SEND_WAIT_MS);
      const done = (ok: boolean) => () => { clearTimeout(timer); resolve(ok); };
      deps.dispatch({ type: "decideRequest", ...action, onSent: done(true), onError: done(false) });
    });

  return async (act) => {
    try {
      if (act.kind === "open") {
        openThread(deps.dispatch, { botId: act.botId, threadId: act.threadId }, deps.getState(), deps.showThreads());
        return true;
      }
      const view = deps.getInbox();
      const row = view?.rows.find((one) => one.tab === "needs-you" && one.card?.requestId === act.requestId && rowBotId(one) === act.botId);
      const card = row?.card;
      const threadId = row ? answerThread(view, row) : null;
      if (!row || !card || !threadId) return false;
      let sent: boolean;
      if (act.kind === "answer") {
        const label = choicesOf(row)[Number(act.choiceId)];
        if (label === undefined || askOf(row) !== "question") return false;
        const response = choiceResponse(row, label);
        sent = await send({ threadId, requestId: act.requestId, behavior: response.behavior, ...(response.message ? { message: response.message } : {}) });
      } else if (askOf(row) !== "approval") {
        return false;
      } else if (act.choice !== "deny" && !approvalDetail(row)) {
        return false;
      } else if (act.choice === "deny") {
        sent = await send({ threadId, requestId: act.requestId, behavior: "deny", message: "Denied by the user." });
      } else if (act.choice === "once") {
        sent = await send({ threadId, requestId: act.requestId, behavior: "allow" });
      } else if (card.allowKey) {
        sent = await send({ threadId, requestId: act.requestId, behavior: "allow", alwaysAllow: { botId: act.botId, key: card.allowKey } });
      } else if (card.allowSession) {
        sent = await send({ threadId, requestId: act.requestId, behavior: "allow", always: true });
      } else {
        return false;
      }
      if (sent) settleInboxRow(row);
      return sent;
    } catch {
      return false;
    }
  };
}
