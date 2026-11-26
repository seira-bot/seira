// The app_settings tool for one turn: find, get and set over the registry, where the entry's tier is the whole policy.
// Writes happen only on the owner's own request: at once with Undo, or, for a risky value or a conversation someone else
// wrote into, on a card the owner taps. A secret never passes through the bot, and an owner-only setting is only explained.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { APP_FEATURES, findAppFeatures, type AppFeature } from "../../shared/app-features.ts";
import { isSettingsCardId, SETTINGS_CARD_IDS, type AppSettingRequest, type AppSettingResult, type SettingsCardId } from "../../shared/app-settings.ts";
import { writeFileAtomic } from "../atomic.ts";
import { appendDecision } from "../decision-log.ts";
import { UNDO_STALE } from "../direct-apply.ts";
import { serverLine } from "../server-lines.ts";
import type { BotRecord, GroupRecord, Store } from "../store.ts";
import type { ThemeTool } from "../themes/tool.ts";
import { cardElsewhere, cardNotInRoom, cardShownStatus, SETTINGS_CARDS } from "./cards.ts";
import { consequenceKey, type Consequence } from "./confirm.ts";
import type { TakenPicture } from "./picture-file.ts";
import { findPlaceEntries, findPlaces, findUiPlaceEntries, findUiPlaces, placePath, placesList, settingsPlaceById, settingsPlaceText, uiPlaceById, uiPlaceText } from "./places.ts";
import { display, findSettings, personOnly, type SettingEntry, type WritableEntry } from "./registry.ts";
import type { SettingsRefusalCode, SettingsVerdict } from "./verdict.ts";

export const TOOL = "app_settings";
export const WRITE_BUDGET = 10;
export const CONFIRM_MS = 15 * 60_000;
export const OPEN_CARD_LIMIT = 3;
const UNDO_FILE = "app-settings-undo.json";
const UNDO_KEEP = 200;
const THEME_ACTIONS: readonly string[] = ["theme", "set_theme", "add_theme_asset", "theme_history", "undo_theme"];
const FIND_LIMIT = 8;
const FEATURE_LIMIT = 5;
const featureLine = (feature: AppFeature) => `${feature.name} — ${feature.place}: ${feature.does}${feature.tools?.length ? ` (tools: ${feature.tools.join(", ")})` : ""}`;
const NOT_SET = "not set";
const text = (value: string) => value || NOT_SET;
/** What a card and the bot see of a change: before → after, or, with no `before`, one line saying what it does. */
interface Shown {
  before?: string;
  after: string;
}
const said = ({ before, after }: Shown) => (before === undefined ? after : `${text(before)} → ${text(after)}`);

/** The tool sends every value as text so strict-schema providers accept it; numbers, true/false and JSON are read back
 * from it when the text alone does not fit the setting. A JSON object or list is judged as itself. */
function parseValue(entry: WritableEntry, value: unknown) {
  const direct = entry.value.safeParse(value);
  if (direct.success || typeof value !== "string") return direct;
  try {
    const json: unknown = JSON.parse(value);
    const read = entry.value.safeParse(json);
    return read.success || (typeof json === "object" && json !== null) ? read : direct;
  } catch {
    return direct;
  }
}

/** What Apply and Undo compare to tell a setting changed since: what it reads as, and the value `current` gives for this
 * change's target (one bot's own fields, a section without its keys). */
async function stateOf(entry: WritableEntry, target: unknown): Promise<string> {
  const read = entry.read();
  try {
    return JSON.stringify([read, (await entry.current(target)) ?? null]);
  } catch {
    return JSON.stringify([read]);
  }
}

export interface Turn {
  botId: string;
  threadId: string;
  generation: string;
}

/** `before`: what Undo writes back, never a key; `after`: what the setting read as once applied, and `state` the changed
 * value itself (stateOf), so Undo can tell it changed since. */
interface Undoable {
  entry: WritableEntry;
  before: unknown;
  after: string;
  state?: string;
}
interface SavedUndo {
  requestId: string;
  entryId: string;
  before?: unknown;
  after: string;
  state?: string;
}

/** A change on a card that waits for the owner's Apply. `was`: the setting as it read when the card was posted; `state`:
 * the same and the value the change replaces (stateOf), so Apply refuses once either differs. `stored`: a picture taken
 * for it, removed unless the change applies. */
interface Waiting {
  requestId: string;
  entry: WritableEntry;
  value: unknown;
  change?: string;
  was: string;
  state: string;
  botId: string;
  botName: string;
  threadId: string;
  messageId: string;
  expiresAt: number;
  stored?: string;
  own: boolean;
  review: { before: string; after: string };
  timer: ReturnType<typeof setTimeout>;
  applying?: true;
}

const REFUSED: Record<SettingsRefusalCode, (where: string) => string> = {
  shared: (where) => `On this server settings change only by hand, in Settings. Nothing changed: tell the user in one line that it is in ${where}.`,
  guest: (where) => `A guest's conversation can't change the owner's settings. Nothing changed: tell the user in one line that the owner changes it in ${where}.`,
  automation: (where) => `A routine, webhook or other automation can't change settings. Nothing changed: say in one line that the person can ask you in their own chat, or change it in ${where}.`,
  unproven: (where) => `This turn's request did not come from the owner here, so nothing changed. Say in one line that the owner can ask you in their own chat, or change it in ${where}.`,
  "not-owner": (where) => `This turn's request did not come from the owner here, so nothing changed. Say in one line that the owner can ask you in their own chat, or change it in ${where}.`,
};

/** What the bot hears once a waiting card has ended. */
export function appSettingDecisionText(card: { appSettingRequest?: AppSettingRequest }): string {
  const request = card.appSettingRequest;
  if (!request?.result) return "The settings card is still waiting for the user.";
  const label = request.label;
  const lines: Record<AppSettingResult, string> = {
    applied: `The user applied the change: ${label} is now ${text(request.after)}. They can undo it from the card.`,
    declined: `The user declined the change to ${label}. Nothing changed.`,
    expired: `The card to change ${label} closed before the user applied it. Nothing changed; ask again only if they still want it.`,
    stale: `${label} changed after the card was shown, so the card no longer applied. Nothing changed; read the setting again before asking anew.`,
    failed: `Applying the change to ${label} failed. Nothing changed.`,
  };
  return lines[request.result];
}

export type UndoResult =
  | { claimed: false }
  | { claimed: true; state: "already_undone" | "undone" }
  | { claimed: true; state: "invalid"; error: string; status: number; stale?: true };

export interface AppSettingsDeps {
  store: Pick<Store, "appendMessage" | "bot" | "messagesFor" | "patchMessage">;
  dataDir: string;
  entries: readonly SettingEntry[];
  /** Whether this turn's request may change settings, at once or only through a card the owner taps (phones.settingsAsker). */
  asker(turn: Turn): SettingsVerdict;
  guestDriven(threadId: string): boolean;
  /** The turn answers a routine, webhook or other automation, owner-written ones included: it changes no setting. */
  automated?(turn: Turn): boolean;
  /** The secret card, as request_credential posts it. */
  requestCredential(bot: BotRecord, threadId: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
  connectorThread(botId: string, threadId: string): { group?: GroupRecord } | null;
  language(threadId: string): string | undefined;
  /** The person's own themes; absent where the server offers none. */
  themes?: ThemeTool;
  /** For a setting that takes a picture file: stores the file the bot names, or says why not. */
  pictures?: { take(turn: Turn, path: string): Promise<TakenPicture>; discard(avatarUrl: string): void };
  /** Settings cards: whether a card's control exists on this server's own computer, and whether its setting is known to be on (null when the server cannot tell). Absent: no cards here. */
  cards?: { here(id: SettingsCardId): boolean; on(id: SettingsCardId): true | null };
  /** Gives a parked turn the answer to the card it waits on; false when no turn waits on that card yet. */
  resume?(threadId: string, messageId: string, text: string): boolean;
  now?(): number;
}

export function createAppSettings(deps: AppSettingsDeps) {
  const { store, entries } = deps;
  const now = deps.now ?? Date.now;
  const writes = new Map<string, number>();
  const waiting = new Map<string, Waiting>();
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const undoFile = join(deps.dataDir, UNDO_FILE);
  const undoable = loadUndo();

  function loadUndo(): Map<string, Undoable> {
    const kept = new Map<string, Undoable>();
    try {
      const saved = JSON.parse(readFileSync(undoFile, "utf8")) as SavedUndo[];
      for (const one of Array.isArray(saved) ? saved : []) {
        const entry = byId.get(one?.entryId);
        if (entry?.tier === "safe" && typeof one.requestId === "string" && typeof one.after === "string") {
          kept.set(one.requestId, { entry, before: one.before, after: one.after, ...(typeof one.state === "string" ? { state: one.state } : {}) });
        }
      }
    } catch {
      // A missing or unreadable file leaves Undo empty.
    }
    return kept;
  }
  /** Security: a section's earlier value is read without its keys, so the file holds none; it is still the owner's alone,
   * since it keeps earlier instructions and names. */
  function saveUndo() {
    const saved: SavedUndo[] = [...undoable].map(([requestId, change]) => ({ requestId, entryId: change.entry.id, before: change.before, after: change.after, ...(change.state ? { state: change.state } : {}) }));
    try {
      writeFileAtomic(undoFile, JSON.stringify(saved), { mode: 0o600 });
    } catch {
      // Undo still works until the server restarts.
    }
  }
  function remember(requestId: string, change: Undoable) {
    undoable.set(requestId, change);
    while (undoable.size > UNDO_KEEP) undoable.delete(undoable.keys().next().value!);
    saveUndo();
  }

  const reply = (status: number, body: Record<string, unknown>) => ({ status, body });
  const refuse = (status: number, error: string) => reply(status, { error });
  const describe = (entry: SettingEntry) => ({ id: entry.id, label: entry.label, tier: entry.tier, value: text(entry.read()), where: placePath(entry.where) });
  const from = (bot: BotRecord, threadId: string) => (deps.connectorThread(bot.id, threadId)?.group ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {});
  const spendWrite = (turn: Turn): string | null => {
    const spent = writes.get(turn.generation) ?? 0;
    if (spent >= WRITE_BUDGET) return `This turn has already changed ${WRITE_BUDGET} settings. Ask the user to send a new message before changing more.`;
    writes.set(turn.generation, spent + 1);
    if (writes.size > 200) writes.delete(writes.keys().next().value!);
    return null;
  };

  /** Writes the value, reading first what Undo would write back. */
  async function write(entry: WritableEntry, value: unknown): Promise<{ refusal: string } | { before: unknown; was: string; after: string; state?: string }> {
    const before = await entry.current(value);
    const was = entry.read();
    const refusal = await entry.write(value);
    if (refusal) return { refusal };
    return { before, was, after: entry.read(), ...(before === undefined ? {} : { state: await stateOf(entry, before) }) };
  }
  const undoOf = (entry: WritableEntry, written: { before: unknown; after: string; state?: string }): Undoable =>
    ({ entry, before: written.before, after: written.after, ...(written.state ? { state: written.state } : {}) });
  /** The applied card's words, in the conversation's language. */
  function appliedCard(threadId: string, entry: WritableEntry, shown: Shown) {
    const language = deps.language(threadId);
    const notSet = (value: string) => value || serverLine(language, "server.appSettings.notSet");
    return { title: serverLine(language, "server.appSettings.changed", { label: entry.label }), subtitle: shown.before === undefined ? shown.after : `${notSet(shown.before)} → ${notSet(shown.after)}` };
  }
  /** Security: a room, or a conversation someone else wrote into, is seen by others, so its cards hold the new value only. */
  const ownerSees = (bot: BotRecord, threadId: string, verdict?: SettingsVerdict) => (verdict === undefined || verdict.kind === "clean") && !deps.connectorThread(bot.id, threadId)?.group;
  const forAudience = (shown: Shown, own: boolean): Shown => (own ? shown : { after: shown.after });
  const requestOf = (entry: WritableEntry, shown: Shown): AppSettingRequest => ({ settingId: entry.id, label: entry.label, ...(shown.before === undefined ? {} : { before: shown.before }), after: shown.after, tier: entry.tier });

  /** Applies the change, posts its applied card with Undo, and logs it in the decision log. */
  async function apply(turn: Turn, bot: BotRecord, entry: WritableEntry, value: unknown, change: string | undefined, own: boolean) {
    const written = await write(entry, value);
    if ("refusal" in written) {
      appendDecision(deps.dataDir, { threadId: turn.threadId, botId: turn.botId, botName: bot.name, tool: TOOL, summary: `${entry.id}: ${change ?? display(value)}`, decision: "auto-denied", source: "app-settings", rule: "settings:failed" });
      return refuse(409, written.refusal);
    }
    const { was, after } = written;
    if (change === undefined && after === was) return reply(200, { text: `${entry.label} already is ${text(after)}. Nothing changed, so no card was shown.` });
    const shown: Shown = change === undefined ? { before: was, after } : { after: change };
    const requestId = randomUUID();
    store.appendMessage(turn.threadId, {
      role: "bot", kind: "options", ...from(bot, turn.threadId),
      card: { ...appliedCard(turn.threadId, entry, forAudience(shown, own)), options: [], requestId, tool: TOOL, fixedOptions: true, appSettingRequest: requestOf(entry, forAudience(shown, own)), answered: "allow", dismissed: true, autoApplied: true },
    });
    remember(requestId, undoOf(entry, written));
    appendDecision(deps.dataDir, { threadId: turn.threadId, requestId, botId: turn.botId, botName: bot.name, tool: TOOL, summary: `${entry.id}: ${said(shown)}`, decision: "auto-approved", source: "app-settings" });
    const done = change === undefined ? `Changed ${entry.label} from ${text(was)} to ${text(after)}.` : `Done: ${change}. ${entry.label} now: ${text(after)}.`;
    return reply(200, { text: `${done} The user can undo it from the card in the conversation.` });
  }

  /** Forgets a waiting card that ended outside this module (Stop closes it); true when it did. */
  function settledElsewhere(change: Waiting): boolean {
    if (change.applying) return false;
    const card = store.messagesFor(change.threadId).find((candidate) => candidate.id === change.messageId)?.card;
    if (card && !card.answered && !card.dismissed && !card.expired) return false;
    clearTimeout(change.timer);
    waiting.delete(change.requestId);
    if (change.stored) deps.pictures?.discard(change.stored);
    return true;
  }
  const openCards = (threadId: string) => [...waiting.values()].filter((one) => one.threadId === threadId && !settledElsewhere(one)).length;

  /** Posts the card the owner taps to apply the change; nothing changes before that. */
  async function ask(turn: Turn, bot: BotRecord, entry: WritableEntry, value: unknown, change: string | undefined, consequence: Consequence | null, own: boolean, stored?: string) {
    const language = deps.language(turn.threadId);
    const state = await stateOf(entry, value);
    const was = entry.read();
    const shown: Shown = change === undefined ? { before: was, after: display(value) } : { after: change };
    const notSet = (value: string) => value || serverLine(language, "server.appSettings.notSet");
    const reviewed = entry.review?.(value) ?? null;
    const review = reviewed ?? { before: was, after: display(value) };
    const cardShown = forAudience(reviewed ?? shown, own);
    const cardLine = cardShown.before === undefined ? cardShown.after : `${notSet(cardShown.before)}${reviewed ? "\n→\n" : " → "}${notSet(cardShown.after)}`;
    const what = consequence ? serverLine(language, consequenceKey(consequence.code), consequence.params) : undefined;
    const requestId = randomUUID();
    const expiresAt = now() + CONFIRM_MS;
    const message = store.appendMessage(turn.threadId, {
      role: "bot", kind: "options", ...from(bot, turn.threadId),
      card: { title: serverLine(language, "server.appSettings.confirmTitle", { label: entry.label }),
        subtitle: [cardLine, what].filter(Boolean).join("\n"),
        options: [serverLine(language, "server.appSettings.apply"), serverLine(language, "server.appSettings.notNow")], requestId, tool: TOOL, fixedOptions: true,
        appSettingRequest: { ...requestOf(entry, cardShown), ...(what ? { consequence: what } : {}), ...(own ? {} : { privateReview: true as const }), expiresAt } },
    });
    const timer = setTimeout(() => expire(requestId), CONFIRM_MS);
    timer.unref?.();
    waiting.set(requestId, { requestId, entry, value, ...(change === undefined ? {} : { change }), was, state, botId: bot.id, botName: bot.name, threadId: turn.threadId, messageId: message.id, expiresAt, ...(stored ? { stored } : {}), own, review, timer });
    appendDecision(deps.dataDir, { threadId: turn.threadId, requestId, botId: bot.id, botName: bot.name, tool: TOOL, summary: `${entry.id}: ${said(shown)}`, decision: "card-shown", source: "app-settings", ...(consequence ? { rule: `settings:${consequence.code}` } : {}) });
    return reply(200, { text: `A card asking the user to apply this is in the conversation: ${said(shown)}. Nothing has changed yet. End this turn now and say in one line that the change waits for their tap on Apply; Seira resumes you with the result.` });
  }

  /** Writes how a waiting card ended on its row; `resume`: the bot hears it once, in `heard` when the row can't say it. */
  function close(threadId: string, messageId: string, result: AppSettingResult, card: Record<string, unknown>, resume: boolean, heard?: string) {
    const message = store.messagesFor(threadId).find((candidate) => candidate.id === messageId);
    const current = message?.card;
    if (!message || !current?.appSettingRequest) return undefined;
    const ended = { ...current, ...card, options: [], appSettingRequest: { ...current.appSettingRequest, ...(card.appSettingRequest as object | undefined), result } };
    store.patchMessage(threadId, message.id, { card: ended });
    if (resume && deps.resume?.(threadId, message.id, heard ?? appSettingDecisionText(ended))) {
      const resumed = { ...ended, appSettingRequest: { ...ended.appSettingRequest, resumed: true } };
      store.patchMessage(threadId, message.id, { card: resumed });
      return resumed;
    }
    return ended;
  }
  /** Ends a waiting card: its row says how, the bot hears it once, and a picture taken for it goes unless it applied. */
  function end(change: Waiting, result: AppSettingResult, card: Record<string, unknown>, heard?: string) {
    clearTimeout(change.timer);
    waiting.delete(change.requestId);
    if (result !== "applied" && change.stored) deps.pictures?.discard(change.stored);
    close(change.threadId, change.messageId, result, card, true, heard);
  }
  /** A waiting card that no change of this run holds: posted before the server restarted, so it can no longer apply. */
  const orphan = (card: { requestId?: string; appSettingRequest?: AppSettingRequest; autoApplied?: boolean; answered?: string; dismissed?: boolean; expired?: boolean } | undefined) =>
    Boolean(card?.appSettingRequest && !card.autoApplied && !card.appSettingRequest.result && !card.answered && !card.dismissed && !card.expired && !(card.requestId && waiting.has(card.requestId)));

  function expire(requestId: string) {
    const change = waiting.get(requestId);
    if (!change || change.applying || settledElsewhere(change)) return;
    appendDecision(deps.dataDir, { threadId: change.threadId, requestId, botId: change.botId, botName: change.botName, tool: TOOL, summary: `${change.entry.id}: ${change.change ?? `${text(change.was)} → ${display(change.value)}`}`, decision: "auto-denied", source: "app-settings", rule: "settings:expired" });
    end(change, "expired", { expired: true });
  }

  async function set(turn: Turn, body: Record<string, unknown>) {
    const bot = store.bot(turn.botId);
    if (!bot) return refuse(404, "This bot no longer exists.");
    /** Refuses with a reason code in the decision log. */
    const deny = (code: string, status: number, error: string) => {
      appendDecision(deps.dataDir, { threadId: turn.threadId, botId: bot.id, botName: bot.name, tool: TOOL, summary: `${typeof body.id === "string" ? body.id.slice(0, 120) : "set"}: refused`, decision: "auto-denied", source: "app-settings", rule: `settings:${code}` });
      return refuse(status, error);
    };
    const entry = typeof body.id === "string" ? byId.get(body.id) : undefined;
    if (!entry) return deny("unknown", 404, `No setting with id ${JSON.stringify(body.id ?? null)}. Use action find first.`);
    const where = placePath(entry.where);
    if (entry.tier === "owner-only") return deny("owner-only", 403, personOnly(entry.label, entry.where));
    const verdict: SettingsVerdict = deps.guestDriven(turn.threadId) ? { kind: "refused", code: "guest" } : deps.automated?.(turn) ? { kind: "refused", code: "automation" } : deps.asker(turn);
    if (verdict.kind === "refused") return deny(verdict.code, 403, REFUSED[verdict.code](where));
    if (entry.tier === "secret") {
      if (body.value !== undefined) return deny("secret-value", 400, `Never send a key or token as a value. Call set on ${entry.id} with no value: a secure card asks the user for it, and you never see it.`);
      const budget = spendWrite(turn);
      if (budget) return deny("budget", 429, budget);
      const posted = await deps.requestCredential(bot, turn.threadId, { credentialId: entry.credentialId, reason: typeof body.reason === "string" ? body.reason : undefined });
      if (!posted.body.error && posted.body.alreadyConfigured === true) return reply(200, { text: `${entry.label} is already set. To replace it, the user changes it in ${where}.` });
      if (posted.status >= 300) return refuse(posted.status, String(posted.body.error ?? "The secure card could not be shown."));
      return reply(200, { text: `A secure card for ${entry.label} is ready in Seira. End this turn now and say in one line that you are waiting for it; Seira resumes you when the user saves it or declines. You never see the key.` });
    }
    const parsed = parseValue(entry, body.value);
    if (!parsed.success) return deny("invalid-value", 400, `${entry.label} takes ${entry.allowed}. ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    const described = entry.describe?.(parsed.data);
    if (described && "refusal" in described) return deny("not-allowed", 409, described.refusal);
    const consequence = entry.confirm?.(parsed.data) ?? null;
    const tap = verdict.kind === "confirm" || consequence !== null;
    if (tap && openCards(turn.threadId) >= OPEN_CARD_LIMIT) return deny("card-limit", 429, `${OPEN_CARD_LIMIT} settings cards already wait for the user here. Nothing changed: ask them to answer those first.`);
    const budget = spendWrite(turn);
    if (budget) return deny("budget", 429, budget);
    const picture = entry.fromFile ? await takePicture(turn, parsed.data) : { value: parsed.data };
    if ("refusal" in picture) return deny("picture", 400, picture.refusal);
    const own = ownerSees(bot, turn.threadId, verdict);
    if (tap) return ask(turn, bot, entry, picture.value, described?.change, consequence, own, picture.stored);
    const applied = await apply(turn, bot, entry, picture.value, described?.change, own);
    if (picture.stored && applied.status >= 300) deps.pictures?.discard(picture.stored);
    return applied;
  }

  const ownersAsk = (turn: Turn) => !deps.guestDriven(turn.threadId) && deps.asker(turn).kind !== "refused";

  /** A value naming a picture file by `path` goes on as the stored picture's `avatarUrl`; an empty path stays, to remove it. */
  async function takePicture(turn: Turn, value: unknown): Promise<{ value: unknown; stored?: string } | { refusal: string }> {
    const { path, ...rest } = value as { path?: unknown };
    if (typeof path !== "string" || !path) return { value };
    if (!deps.pictures) return { refusal: "Pictures can't be set from a file here." };
    const taken = await deps.pictures.take(turn, path);
    return "refusal" in taken ? taken : { value: { ...rest, avatarUrl: taken.avatarUrl }, stored: taken.avatarUrl };
  }

  /** A theme is the person's whose own message began the work, never a teammate's or a guest's. */
  async function theme(turn: Turn, body: Record<string, unknown>) {
    const themes = deps.themes;
    if (!themes) return refuse(404, "Themes are not available on this server.");
    const bot = store.bot(turn.botId);
    if (!bot) return refuse(404, "This bot no longer exists.");
    const person = deps.guestDriven(turn.threadId) ? null : themes.person(turn);
    if (!person) return refuse(403, "A theme changes only for the person who asked, in their own conversation. This turn was not started by them here, so nothing changed.");
    if (body.action === "theme") return themes.overview(person, body.id);
    if (body.action === "theme_history") return themes.history(person);
    const asked = body.action === "set_theme" ? themes.wanted(person, body) : body.action === "undo_theme" ? themes.undo(person, body) : null;
    if (asked && "error" in asked) return refuse(400, asked.error);
    const budget = spendWrite(turn);
    if (budget) return refuse(429, budget);
    return asked ? apply(turn, bot, themes.entry(person), asked.wear, asked.change, ownerSees(bot, turn.threadId)) : themes.addAsset(turn, person, body);
  }

  /** Shows a setting's own control in the conversation. Security invariant: the reply and the row carry fixed words and
   * the card's id only; the control's code, link and address never pass through here. */
  function showCard(turn: Turn, body: Record<string, unknown>) {
    if (!isSettingsCardId(body.card)) return refuse(404, `No settings card ${JSON.stringify(body.card ?? null)}. Cards: ${SETTINGS_CARD_IDS.join(", ")}.`);
    const card = SETTINGS_CARDS[body.card];
    const bot = store.bot(turn.botId);
    if (!bot) return refuse(404, "This bot no longer exists.");
    if (!ownersAsk(turn)) return refuse(403, "A settings card shows only in the owner's own conversation, when they asked. This turn was not started by the owner here, so nothing was shown.");
    if (!deps.cards?.here(body.card)) return reply(200, { text: cardElsewhere(card) });
    if (deps.connectorThread(bot.id, turn.threadId)?.group) return reply(200, { text: cardNotInRoom(card) });
    const budget = spendWrite(turn);
    if (budget) return refuse(429, budget);
    store.appendMessage(turn.threadId, { role: "bot", kind: "text", text: card.text, settingsCard: { id: body.card } });
    return reply(200, { text: cardShownStatus(card, deps.cards.on(body.card)) });
  }

  /** Shows a place of the app in the conversation, as a card the person clicks to go there. Security invariant: the row holds
   * the map's own words and the place id only; the model chooses an id and nothing else, so it writes no label, step or
   * position. The bot never clicks the card and never hears what the person does with it. */
  function showPlace(turn: Turn, body: Record<string, unknown>) {
    const bot = store.bot(turn.botId);
    if (!bot) return refuse(404, "This bot no longer exists.");
    if (!ownersAsk(turn)) return refuse(403, "A place card shows only in the owner's own conversation, when they asked. This turn was not started by the owner here, so nothing was shown.");
    if (deps.connectorThread(bot.id, turn.threadId)?.group) return refuse(403, "No place card shown: a place card is not drawn in a room. Tell the user in one line where it is, from action places, or ask them to ask you in your own chat, where you can show it.");
    const place = uiPlaceById(body.place);
    const settingsPlace = place ? undefined : settingsPlaceById(body.place);
    if (!place && !settingsPlace) {
      const query = typeof body.place === "string" ? body.place.slice(0, 200) : "";
      const near = [
        ...findUiPlaceEntries(query, 3).map((one) => `${one.id} (${one.label})`),
        ...findPlaceEntries(query, 3).flatMap((one) => (settingsPlaceById(one.id) ? [`${one.id} (${one.path})`] : [])),
      ];
      return refuse(404, `No place with id ${JSON.stringify(typeof body.place === "string" ? body.place.slice(0, 80) : null)}. ${near.length ? `Near matches: ${near.join("; ")}.` : "No near match."} Use action places to find the id; do not guess one.`);
    }
    const budget = spendWrite(turn);
    if (budget) return refuse(429, budget);
    const shown = place ? { id: place.id, text: uiPlaceText(place), label: place.label } : { id: settingsPlace!.id, text: settingsPlaceText(settingsPlace!), label: settingsPlace!.path };
    store.appendMessage(turn.threadId, { role: "bot", kind: "text", text: shown.text, uiPlace: { id: shown.id } });
    return reply(200, { text: `Place card shown: ${shown.label}. The person clicks the card to be taken there; you cannot click it and you never see what they do. Tell the user in one plain line that the card is in the chat.` });
  }

  return {
    async handle(body: Record<string, unknown>, turn: Turn): Promise<{ status: number; body: Record<string, unknown> }> {
      if (body.action === "find") {
        const query = typeof body.query === "string" ? body.query : "";
        const hits = findSettings(entries, query, FIND_LIMIT).map(describe);
        if (hits.length) return reply(200, { text: JSON.stringify(hits) });
        const places = [...findPlaces(query), ...findUiPlaces(query, 3)];
        return reply(200, { text: `No setting you can change matches ${JSON.stringify(query)}.${places.length ? ` Where the person finds it in the app: ${places.join("; ")}.` : " Try other words, or use action places."}` });
      }
      if (body.action === "places") {
        const query = typeof body.query === "string" ? body.query.trim() : "";
        const places = query ? [...findPlaces(query), ...findUiPlaces(query)] : [];
        return reply(200, { text: query ? (places.length ? places.join("\n") : `No place in the app matches ${JSON.stringify(query)}. Say you do not know where it is, or try other words; do not name a menu or button you were not given.`) : `${placesList()}\nThe rest of the app (sidebar, chat header, message box, messages, Automations, Board, People, Inbox, Files, Apps) is searched with words: pass query, for example "automations calendar".` });
      }
      if (body.action === "features") {
        const query = typeof body.query === "string" ? body.query.trim() : "";
        if (!query) return reply(200, { text: APP_FEATURES.map((feature) => `${feature.name} — ${feature.place}`).join("\n") });
        const hits = findAppFeatures(query, FEATURE_LIMIT);
        return reply(200, { text: hits.length ? hits.map(featureLine).join("\n") : `No feature of the app matches ${JSON.stringify(query)}. Here is every feature:\n${APP_FEATURES.map((feature) => `${feature.name} — ${feature.place}`).join("\n")}` });
      }
      if (body.action === "get") {
        const entry = typeof body.id === "string" ? byId.get(body.id) : undefined;
        if (!entry) return refuse(404, `No setting with id ${JSON.stringify(body.id ?? null)}. Use action find first.`);
        return reply(200, { text: JSON.stringify({ ...describe(entry), help: entry.help, ...("allowed" in entry ? { allowed: entry.allowed } : {}), ...entry.more?.(),
          change: entry.tier === "owner-only" ? `only the person, in ${placePath(entry.where)}` : entry.tier === "secret" ? "set with no value opens a secure card"
            : entry.confirm ? "set applies at once with Undo on the card, or, for a value with lasting effects, posts a card the user taps to apply it" : "set applies at once, with Undo on the card" }) });
      }
      if (body.action === "set") return set(turn, body);
      if (body.action === "show_card") return showCard(turn, body);
      if (body.action === "show_place") return showPlace(turn, body);
      if (typeof body.action === "string" && THEME_ACTIONS.includes(body.action)) return theme(turn, body);
      return refuse(400, `action must be find, get, set, show_card, show_place, places, features, ${THEME_ACTIONS.join(", ")}.`);
    },

    /** Closes a waiting card posted before the server restarted, as expired; returns the closed card for the parked turn
     * to hear, or null when the card is no such card. */
    expireOrphan(threadId: string, messageId: string) {
      const card = store.messagesFor(threadId).find((candidate) => candidate.id === messageId)?.card;
      if (!orphan(card)) return null;
      appendDecision(deps.dataDir, { threadId, ...(card!.requestId ? { requestId: card!.requestId } : {}), tool: TOOL, summary: `${card!.appSettingRequest!.settingId}: ${card!.appSettingRequest!.after}`, decision: "auto-denied", source: "app-settings", rule: "settings:expired" });
      return close(threadId, messageId, "expired", { expired: true }, false) ?? null;
    },

    /** The owner's answer to a waiting card; null when the card is no settings card. Apply needs `ownerReview`: the desktop
     * app at this computer or an admin session. Declining needs only the right to answer the card. */
    async resolve(args: { threadId: string; requestId: string; behavior: string; ownerReview: boolean }): Promise<{ status: number; body: Record<string, unknown> } | null> {
      const message = store.messagesFor(args.threadId).find((candidate) => candidate.card?.requestId === args.requestId && candidate.card.appSettingRequest);
      const card = message?.card;
      const request = card?.appSettingRequest;
      if (!message || !card || !request) return null;
      if (card.answered || card.dismissed || card.expired) return reply(200, { ok: true, outcome: card.answered === "allow" ? "allowed-once" : "rejected", alreadySettled: true });
      const change = waiting.get(args.requestId);
      if (args.behavior === "allow" && !args.ownerReview) return refuse(403, "Only the owner applies this change, from the desktop app or a device paired with full access.");
      if (change?.applying) return reply(200, { ok: true, outcome: "allowed-once", alreadySettled: true });
      const summary = change ? `${change.entry.id}: ${change.change ?? `${text(change.was)} → ${display(change.value)}`}` : `${request.settingId}: ${request.after}`;
      const log = (decision: "user-approved" | "user-denied" | "auto-denied", rule?: string) =>
        appendDecision(deps.dataDir, { threadId: args.threadId, requestId: args.requestId, ...(change ? { botId: change.botId, botName: change.botName } : {}), tool: TOOL, summary, decision, source: "app-settings", ...(rule ? { rule } : {}) });
      if (!change || now() >= change.expiresAt) {
        log("auto-denied", "settings:expired");
        if (change) end(change, "expired", { expired: true });
        else close(args.threadId, message.id, "expired", { expired: true }, true);
        return refuse(409, "This card has closed. Nothing changed.");
      }
      if (args.behavior !== "allow") {
        log("user-denied");
        end(change, "declined", { answered: "deny" });
        return reply(200, { ok: true, outcome: "rejected" });
      }
      change.applying = true;
      clearTimeout(change.timer);
      if ((await stateOf(change.entry, change.value)) !== change.state) {
        log("user-denied", "settings:stale");
        end(change, "stale", { expired: true });
        return refuse(409, "This setting changed after the card was shown. Nothing changed.");
      }
      const written = await write(change.entry, change.value);
      if ("refusal" in written) {
        log("user-denied", "settings:failed");
        end(change, "failed", { answered: "deny" }, `Applying the change to ${change.entry.label} failed: ${written.refusal} Nothing changed.`);
        return refuse(409, "The change could not be applied. Nothing changed.");
      }
      const shown: Shown = change.change === undefined ? { before: written.was, after: written.after } : { after: change.change };
      remember(args.requestId, undoOf(change.entry, written));
      log("user-approved");
      end(change, "applied", { ...appliedCard(change.threadId, change.entry, forAudience(shown, change.own)), answered: "allow", dismissed: true, autoApplied: true, appSettingRequest: { ...requestOf(change.entry, forAudience(shown, change.own)) } });
      return reply(200, { ok: true, outcome: "allowed-once" });
    },

    /** The full current and new value of a waiting card, for the owner only. Security invariant: the full old value goes only
     * to the owner, never into the conversation, and the stored values hold no key. */
    review(args: { threadId: string; requestId: string; ownerReview: boolean }): { status: number; body: Record<string, unknown> } | null {
      const message = store.messagesFor(args.threadId).find((candidate) => candidate.card?.requestId === args.requestId && candidate.card.appSettingRequest);
      const card = message?.card;
      if (!message || !card?.appSettingRequest) return null;
      if (!args.ownerReview) return refuse(403, "Only the owner sees this, from the desktop app or a device paired with full access.");
      const change = waiting.get(args.requestId);
      if (card.answered || card.dismissed || card.expired || !change || now() >= change.expiresAt) return refuse(409, "This card has closed.");
      return reply(200, { before: change.review.before, after: change.review.after });
    },

    /** Undo on an applied card: restores the value read before the change, unless it changed since. */
    async undo(args: { threadId: string; requestId: string }): Promise<UndoResult> {
      const message = store.messagesFor(args.threadId).find((candidate) => candidate.card?.requestId === args.requestId && candidate.card.appSettingRequest);
      const current = message?.card;
      if (!message || !current) return { claimed: false };
      if (current.undone) return { claimed: true, state: "already_undone" };
      const change = undoable.get(args.requestId);
      if (!change || current.answered !== "allow") return { claimed: true, state: "invalid", error: "This change can't be undone here.", status: 409 };
      const moved = change.entry.read() !== change.after || (change.state !== undefined && (await stateOf(change.entry, change.before)) !== change.state);
      if (moved) return { claimed: true, state: "invalid", error: UNDO_STALE, status: 409, stale: true };
      const refusal = change.before === undefined ? "The earlier value is not one that can be set back." : await change.entry.write(change.before);
      if (refusal) return { claimed: true, state: "invalid", error: refusal, status: 409 };
      undoable.delete(args.requestId);
      saveUndo();
      store.patchMessage(args.threadId, message.id, { card: { ...current, undone: true } });
      return { claimed: true, state: "undone" };
    },
  };
}
