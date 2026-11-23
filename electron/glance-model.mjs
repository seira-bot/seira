// What Glance shows, worked out from the feed the page sends. No Electron here: the visor, the tray and main only draw it.

/** The numbers of GLANCE_LIMITS in shared/glance.ts; glance-model.node-test.mjs keeps the two equal. */
export const GLANCE_LIMITS = Object.freeze({ bots: 12, name: 80, line: 160, title: 240, choices: 4, choiceLabel: 80, label: 120, id: 128, detail: 400 });
/** How long a bot that finished stays in Glance. */
export const DONE_MS = 4000;
export const COMPACT_MAX = 4;

const LABEL_KEYS = ["glance", "working", "needsYou", "question", "failed", "finished", "failedLine", "openChat", "deny", "allowOnce", "alwaysAllow", "couldNotSend", "close"];
const STATES = new Set(["working", "needs", "question", "failed"]);
const AVATAR = /^\/api\/attachments\/[A-Za-z0-9_-]+\.(?:png|jpe?g|gif|webp)$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
const LANG = /^[A-Za-z0-9-]{1,35}$/;
const RANK = { needs: 0, question: 0, failed: 1, working: 2, done: 3 };

// oxlint-disable-next-line no-control-regex
const CONTROL_KEEP_LINES = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
const clean = (value) => (typeof value === "string" ? value.replace(CONTROL, "") : null);
const within = (value, limit) => value !== null && [...value].length <= limit;
const text = (value, limit, { empty = false } = {}) => {
  const out = clean(value);
  return out !== null && within(out, limit) && (empty || out.length > 0) ? out : null;
};

function validChoice(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = text(raw.id, GLANCE_LIMITS.id), label = text(raw.label, GLANCE_LIMITS.choiceLabel);
  return id !== null && label !== null ? { id, label } : null;
}

function validAsk(raw) {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || (raw.kind !== "approval" && raw.kind !== "question")) return undefined;
  const requestId = text(raw.requestId, GLANCE_LIMITS.id), title = text(raw.title, GLANCE_LIMITS.title, { empty: true });
  const detail = clean(raw.detail) !== null && [...raw.detail].length <= GLANCE_LIMITS.detail ? raw.detail.replace(CONTROL_KEEP_LINES, "") : null;
  if (requestId === null || title === null || detail === null || !Array.isArray(raw.choices) || raw.choices.length > GLANCE_LIMITS.choices || typeof raw.canAlways !== "boolean") return undefined;
  const choices = raw.choices.map(validChoice);
  if (choices.includes(null)) return undefined;
  return { kind: raw.kind, requestId, title, detail, choices: raw.kind === "approval" ? [] : choices, canAlways: raw.kind === "approval" && raw.canAlways };
}

function validBot(raw) {
  if (!raw || typeof raw !== "object" || !STATES.has(raw.state)) return null;
  const botId = text(raw.botId, GLANCE_LIMITS.id), threadId = text(raw.threadId, GLANCE_LIMITS.id);
  const name = text(raw.name, GLANCE_LIMITS.name), line = text(raw.line, GLANCE_LIMITS.line, { empty: true });
  if (botId === null || threadId === null || name === null || line === null) return null;
  if (raw.avatarUrl !== null && typeof raw.avatarUrl !== "string") return null;
  if (raw.color !== null && typeof raw.color !== "string") return null;
  if (raw.startedAt !== null && !(typeof raw.startedAt === "number" && Number.isFinite(raw.startedAt) && raw.startedAt >= 0)) return null;
  const ask = validAsk(raw.ask);
  if (ask === undefined) return null;
  return {
    botId, threadId, name, line, state: raw.state, startedAt: raw.startedAt,
    avatarUrl: raw.avatarUrl !== null && AVATAR.test(raw.avatarUrl) ? raw.avatarUrl : null,
    color: raw.color !== null && COLOR.test(raw.color) ? raw.color : null,
    ask: raw.state === "needs" || raw.state === "question" ? ask : null,
  };
}

/** Security: a page cannot grow the visor or main's memory, and no string reaches the visor with a control character. */
export function validFeed(value) {
  if (!value || typeof value !== "object" || value.version !== 1) return null;
  const lang = clean(value.lang);
  if (lang === null || !LANG.test(lang) || !Array.isArray(value.bots) || value.bots.length > GLANCE_LIMITS.bots) return null;
  if (!value.labels || typeof value.labels !== "object") return null;
  const labels = {};
  for (const key of LABEL_KEYS) {
    const label = text(value.labels[key], GLANCE_LIMITS.label);
    if (label === null) return null;
    labels[key] = label;
  }
  const bots = [], keys = new Set();
  for (const raw of value.bots) {
    const bot = validBot(raw);
    if (!bot) return null;
    if (!keys.has(keyOf(bot))) { keys.add(keyOf(bot)); bots.push(bot); }
  }
  return { version: 1, lang, bots, labels };
}

export const keyOf = (bot) => `${bot.botId}\n${bot.threadId}`;
export const fill = (template, name) => String(template).split("{name}").join(name);

export function initialState() {
  return { seen: new Map(), failedShown: new Set(), handled: new Set(), done: new Map(), labels: null };
}

const byPriority = (a, b) => RANK[a.entry.state] - RANK[b.entry.state]
  || (a.entry.state === "working" ? (a.entry.startedAt ?? Infinity) - (b.entry.startedAt ?? Infinity) : 0)
  || (a.entry.state === "done" ? b.entry.until - a.entry.until : 0)
  || a.order - b.order;

const published = (entry) => { const out = { ...entry }; delete out.until; return out; };

/**
 * `view.entries` hold the bots in priority order: a bot that needs the person or asks, then one that failed, then the one that
 * works longest, then one that finished. A failure shows only once the model saw that bot in another state, so an old failure
 * at start stays out. `view.openOn` is set when an ask with a new request id appears, unless the main window has focus
 * or Glance is hidden; the ask then waits and opens when it can.
 */
export function step(state, feed, now, { mainFocused = false, hidden = false } = {}) {
  const bots = feed?.bots ?? [];
  const labels = feed?.labels ?? state.labels;
  const present = new Set(bots.map(keyOf));
  const seen = new Map(), failedShown = new Set(), done = new Map();
  for (const bot of bots) {
    const key = keyOf(bot), before = state.seen.get(key);
    seen.set(key, bot);
    if (bot.state === "failed" && (state.failedShown.has(key) || (before && before.state !== "failed"))) failedShown.add(key);
  }
  for (const [key, entry] of state.done) if (!present.has(key) && entry.until > now) done.set(key, entry);
  for (const [key, before] of state.seen) {
    if (!present.has(key) && before.state === "working") done.set(key, { ...before, state: "done", ask: null, line: "", until: now + DONE_MS });
  }
  const shown = bots.filter((bot) => bot.state !== "failed" || failedShown.has(keyOf(bot))).map((bot) => ({ ...bot, key: keyOf(bot) }));
  const entries = [...shown, ...[...done].map(([key, entry]) => ({ ...entry, key }))]
    .map((entry, order) => ({ entry, order }))
    .sort(byPriority)
    .map(({ entry }) => published(entry));
  const asking = entries.filter((entry) => entry.ask);
  const handled = new Set([...state.handled].filter((id) => asking.some((entry) => entry.ask.requestId === id)));
  const fresh = asking.filter((entry) => !handled.has(entry.ask.requestId));
  let openOn = null;
  if (fresh.length && !mainFocused && !hidden) {
    openOn = { key: fresh[0].key, requestId: fresh[0].ask.requestId };
    for (const entry of fresh) handled.add(entry.ask.requestId);
  }
  const latest = [...done].sort((a, b) => b[1].until - a[1].until)[0];
  const untils = [...done.values()].map((entry) => entry.until);
  return {
    state: { seen, failedShown, handled, done, labels },
    view: {
      entries, compact: entries.slice(0, COMPACT_MAX).map((entry) => entry.key), active: entries.length > 0 && labels !== null,
      done: latest ? latest[0] : null, openOn, nextAt: untils.length ? Math.min(...untils) : null, labels,
    },
  };
}

/** Security: an answer from the visor counts only for a bot, a thread and a request Glance shows now. */
export function actAllowed(feed, act) {
  if (!feed || !Array.isArray(feed.bots) || !act || typeof act !== "object") return false;
  const bot = feed.bots.find((entry) => entry.botId === act.botId && entry.threadId === act.threadId);
  if (!bot) return false;
  if (act.kind === "open") return true;
  const ask = bot.ask;
  if (!ask || ask.requestId !== act.requestId) return false;
  if (act.kind === "approval") {
    if (ask.kind !== "approval") return false;
    if (act.choice === "deny") return true;
    const seen = typeof ask.detail === "string" && ask.detail.length > 0;
    return seen && (act.choice === "once" || (act.choice === "always" && ask.canAlways === true));
  }
  if (act.kind === "answer") return ask.kind === "question" && ask.choices.some((choice) => choice.id === act.choiceId);
  return false;
}

/** The act with only its own fields, for the page. */
export function cleanAct(act) {
  if (!act || typeof act !== "object" || typeof act.botId !== "string" || typeof act.threadId !== "string") return null;
  const base = { botId: act.botId, threadId: act.threadId };
  if (act.kind === "open") return { kind: "open", ...base };
  if (typeof act.requestId !== "string") return null;
  if (act.kind === "approval" && typeof act.choice === "string") return { kind: "approval", ...base, requestId: act.requestId, choice: act.choice };
  if (act.kind === "answer" && typeof act.choiceId === "string") return { kind: "answer", ...base, requestId: act.requestId, choiceId: act.choiceId };
  return null;
}

export const STATE_COLOR = Object.freeze({ working: "#4f8dff", needs: "#f5a524", question: "#f5a524", failed: "#ff5c6c", done: "#3ccf8e" });

/** The state in the app's words, for a tray row. */
export function stateText(entry, labels) {
  if (entry.state === "working") return labels.working;
  if (entry.state === "needs") return labels.needsYou;
  if (entry.state === "question") return labels.question;
  if (entry.state === "failed") return labels.failed;
  return fill(labels.finished, entry.name);
}
