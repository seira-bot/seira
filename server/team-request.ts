// Seira's team suggestion for a new person. The question is Seira's own line, with no AI call; the person's next line
// is marked, and Seira's AI reads it as a request to suggest a team through suggest_team. The suggestion is a card
// that creates nothing: a team exists only after the person creates it (routes/teams.ts).
import type { TeamIntroBot } from "../packages/phone-protocol/src/team-suggestion.ts";
import { suggestionPackage, type TeamSuggestionInput } from "../shared/team-suggestion.ts";
import type { PackageDocument } from "../shared/package-format.ts";
import { linePersonKey } from "./host/thread-person.ts";
import { serverLine } from "./server-lines.ts";
import type { Message, Store } from "./store.ts";
import { extractTurnImages } from "./turn-images.ts";

export type TeamRequestStore = Pick<Store, "bot" | "taskByThread" | "messagesFor" | "patchMessage" | "appendMessage">;

const command = (line: Message): boolean => (line.text ?? "").trimStart().startsWith("/");

/** Seira's question about the person's work. Null when this conversation is not one of the bot's own. */
export function askForTeam(store: TeamRequestStore, botId: string, threadId: string, language: string | undefined): Message | null {
  if (!store.bot(botId) || !store.taskByThread(botId, threadId)) return null;
  const thread = store.messagesFor(threadId);
  const last = thread.at(-1);
  if (last?.teamAsk) return last;
  return store.appendMessage(threadId, { role: "bot", kind: "text", text: serverLine(language, "server.team.ask"), teamAsk: true });
}

export interface TeamTurn {
  threadId: string;
  line: Message;
  /** The person wrote it here: not a routine, another bot, a card, a coordination or an edit. */
  person: boolean;
  editedFrom?: string;
  /** The bot's model has its tools mounted. */
  mounted: boolean;
}

/** The stored line, marked, when it is the answer to the team question; null when it runs as typed. The returned copy
 * is kept by startTurn, so a retry or an edit of the line stays a team request. */
export function takeTeamRequest(store: TeamRequestStore, turn: TeamTurn): Message | null {
  const { threadId, line } = turn;
  if (line.role !== "user" || line.peerAsk || !turn.mounted) return null;
  if (line.teamRequest) return line;
  const thread = store.messagesFor(threadId);
  if (turn.editedFrom) {
    const edited = thread.find((message) => message.id === turn.editedFrom);
    const author = edited && linePersonKey(edited), editor = linePersonKey(line);
    return edited?.teamRequest && !command(line) && !(author && editor && author !== editor) ? mark(store, threadId, line) : null;
  }
  if (!turn.person || line.relayed || command(line)) return null;
  const index = thread.findIndex((message) => message.id === line.id);
  const before = index < 0 ? thread : thread.slice(0, index);
  const ask = before.findLastIndex((message) => message.teamAsk);
  if (ask < 0 || before.slice(ask + 1).some((message) => message.role === "user")) return null;
  return mark(store, threadId, line);
}

function mark(store: TeamRequestStore, threadId: string, line: Message): Message {
  return store.patchMessage(threadId, line.id, { teamRequest: true }) ?? { ...line, teamRequest: true };
}

const INSTRUCTION = "The person answered your question about their work. Suggest a team of bots for it: call suggest_team one time with a short "
  + "department name, a summary, 2 to 6 bots (name, role, job, instructions) and, only if it helps, group chats. Base it only on what the "
  + "person said. If you cannot tell what their work is, ask one question instead. Do not call create_bot, propose_team_setup or create_room: "
  + "the person chooses in the card, and nothing exists until they do. After the call, say in one short line that the suggestion is in the "
  + "chat, and end your turn.";

/** What the bot reads for a team request, from the stored line, so a direct send, a queued one, a retry and an edit read alike. */
export function teamTurnText(line: Message, nativeImages: boolean): string {
  const words = nativeImages ? extractTurnImages(line.text ?? "").text : line.text ?? "";
  return `${words}\n\n${INSTRUCTION}`;
}

/** The suggestion card, from what the AI wrote; every older open card becomes replaced. Nothing is created. */
export function postTeamSuggestion(store: TeamRequestStore, threadId: string, language: string | undefined,
  input: TeamSuggestionInput & { firstTask?: string }): Message {
  const document = suggestionPackage(input);
  for (const message of store.messagesFor(threadId)) {
    if (message.teamSuggestion?.state === "open") store.patchMessage(threadId, message.id, { teamSuggestion: { ...message.teamSuggestion, state: "replaced" } });
  }
  const firstTask = input.firstTask?.trim().slice(0, 500);
  const bots = document.package.agents.map((agent) => agent.title ? `${agent.name} (${agent.title})` : agent.name).join(", ");
  return store.appendMessage(threadId, {
    role: "bot", kind: "text", text: serverLine(language, "server.team.suggested", { department: document.package.name, bots }),
    teamSuggestion: { document: document as unknown as Record<string, unknown>, ...(firstTask ? { firstTask } : {}), state: "open" },
  });
}

export interface OpenSuggestion { message: Message; suggestion: NonNullable<Message["teamSuggestion"]> }

export function openSuggestion(store: TeamRequestStore, threadId: string, messageId: string): OpenSuggestion | null {
  const message = store.messagesFor(threadId).find((candidate) => candidate.id === messageId);
  return message?.teamSuggestion?.state === "open" ? { message, suggestion: message.teamSuggestion } : null;
}

/** Marks the card, and adds Seira's introduction of the team that was created. */
export function settleSuggestion(store: TeamRequestStore, threadId: string, open: OpenSuggestion, state: "created" | "skipped",
  language: string | undefined, created?: { department: string; document: PackageDocument; bots: ReadonlyArray<{ id: string; name: string }> }): Message | null {
  store.patchMessage(threadId, open.message.id, { teamSuggestion: { ...open.suggestion, state } });
  if (state !== "created" || !created) return null;
  const agents = created.document.package.agents;
  const bots: TeamIntroBot[] = created.bots.map((bot, index) => {
    const agent = agents.length === created.bots.length ? agents[index] : agents.find((candidate) => candidate.name === bot.name);
    return { id: bot.id, name: bot.name, job: agent?.description ?? agent?.title ?? "" };
  });
  const names = bots.map((bot) => bot.name).join(", ");
  return store.appendMessage(threadId, {
    role: "bot", kind: "text", text: serverLine(language, "server.team.intro", { department: created.department, bots: names }),
    teamIntro: { department: created.department, bots, ...(open.suggestion.firstTask ? { firstTask: open.suggestion.firstTask } : {}) },
  });
}
