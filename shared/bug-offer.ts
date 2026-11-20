// Whether an error is Seira's own fault, so the chat may offer a bug report the bot wrote (server/host/devs-reports.ts),
// and the fingerprint the report service groups reports by. An error the person can fix never counts: signed out, a
// spend or usage limit, no internet, a request too large for the model, or a file that is itself broken. Each of those
// already has its own way out, and none is a bug.

export interface ErrorFacts {
  /** The error as the turn or the step reported it, with its stack trace when there is one. */
  text: string;
  /** The step's tool, for a failed step; absent for a failed turn or a request the app made. */
  tool?: string;
  /** A failed-turn row's flags (shared/failed-turn.ts): each one names a cause the person fixes. */
  setup?: boolean;
  claudeUpdate?: boolean;
  limitResetsAt?: number;
  place?: unknown;
  /** One of the server's own fixed notices: it already says what to do. */
  nameCode?: string;
}

/** What the report service hashes to find an open issue about the same error. No field holds a path, an address or a number. */
export interface ErrorFingerprint {
  kind: string;
  step?: string;
  frame?: string;
}

const PERSON_CAN_FIX: readonly RegExp[] = [
  // Signed out, or a sign-in or key refused.
  /\b(?:sign(?:ed)?[ -]?(?:in|out)|log(?:ged)?[ -]?(?:in|out)|not authenticated|unauthori[sz]ed|authenticat\w*|api[ _-]?key|credentials?|oauth|token (?:expired|revoked|invalid)|401|403|forbidden)\b/i,
  // A spend, usage or rate limit.
  /\b(?:usage limit|spend(?:ing)? limit|rate[ -]?limit\w*|quota|credits?|billing|insufficient|payment|402|429|too many requests|limit reached|overloaded|529)\b/i,
  // No internet, or a server that could not be reached.
  /\b(?:offline|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|fetch failed|failed to fetch|NetworkError|load failed|network|socket hang up|no internet|could not be reached|unreachable|getaddrinfo)\b/i,
  // A request too large for the model.
  /\b(?:too large|too long|too big|413|context (?:length|window)|maximum context|token limit|max(?:imum)? tokens|exceeds the limit)\b/i,
  // A file that is broken, missing or locked.
  /\b(?:ENOENT|EACCES|EPERM|EISDIR|ENOTDIR|EMFILE|ENOSPC|no such file|permission denied|not permitted|corrupt\w*|malformed|unsupported (?:file|format|image|media)|invalid (?:pdf|zip|image|file|csv|xlsx?|docx?|encoding|utf-?8)|unexpected (?:token|end of (?:JSON|input))|is not valid JSON|JSON at position|bad zip|end of central directory|password[- ]protected|encrypted file)\b/i,
];

/** A JavaScript exception: a fault in code, not in what the person gave it. */
const CODE_FAULT = /\b(?:TypeError|ReferenceError|RangeError|InternalError|AggregateError|AssertionError|ERR_ASSERTION|ERR_INTERNAL_ASSERTION|ERR_INVALID_ARG_TYPE|ERR_INVALID_STATE)\b|Cannot read propert(?:y|ies) of (?:undefined|null)|Cannot (?:set|destructure) propert|\bis not a (?:function|constructor)\b|\bis not (?:defined|iterable)\b|Maximum call stack size exceeded|\bunhandled (?:promise )?rejection\b|\buncaught exception\b/i;
/** Seira's own tools stalled or went away: a timeout or a closed connection inside the app. */
const STALL = /\b(?:timed out|timeout|did not answer|stopped answering|connection closed|server exited|session closed|server input closed)\b/i;
const STACK_LINE = /^\s*at\s/;
const SEIRA_FILE = /(?:^|[\\/(\s])((?:server|src|shared|packages)[\\/][^\s:()]+)/;
const OWN_TOOL = /^(?:mcp__agents__|agents__|agents_|agents\.)/i;

/** A step of Seira's own "agents" tool server, as each engine spells it (server/mcp-failure.ts mcpServerOfTool). */
export const isSeiraTool = (tool: string): boolean => OWN_TOOL.test(tool);

const stackLines = (text: string) => text.split("\n").filter((line) => STACK_LINE.test(line));

/** Seira's own frame nearest the error, as "function (path)" without line numbers, so a new build keeps the same fingerprint. */
function seiraFrame(text: string): string | undefined {
  for (const line of stackLines(text)) {
    if (/node_modules/.test(line)) continue;
    const file = SEIRA_FILE.exec(line)?.[1];
    if (!file) continue;
    const name = /^\s*at\s+(?:async\s+)?([\w$.<>[\]]+)\s+\(/.exec(line)?.[1];
    const path = file.replace(/\\/g, "/").replace(/(?::\d+)+$/, "");
    return (name ? `${name} (${path})` : path).slice(0, 200);
  }
  return undefined;
}

/** Whether the chat may offer a bug report for this error: it is Seira's own fault, and the person cannot fix it. */
export function seiraOwnsError(facts: ErrorFacts): boolean {
  if (facts.setup || facts.claudeUpdate || facts.limitResetsAt || facts.place || facts.nameCode) return false;
  const text = facts.text ?? "";
  if (!text.trim() || PERSON_CAN_FIX.some((pattern) => pattern.test(text))) return false;
  // Another tool's error is that tool's answer: a command the bot ran, a connected app, the engine's own file tools.
  if (facts.tool !== undefined && !isSeiraTool(facts.tool)) return false;
  if (CODE_FAULT.test(text)) {
    const frames = stackLines(text);
    return frames.length === 0 || seiraFrame(text) !== undefined;
  }
  return facts.tool !== undefined && STALL.test(text);
}

/** One line of an error with nothing particular to one person or one run: paths, addresses, quoted text, ids and numbers go. */
export function errorKind(line: string): string {
  return line
    .replace(/\bhttps?:\/\/\S+/gi, "<url>")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>")
    .replace(/(?:[A-Za-z]:)?(?:~|\.{1,2})?(?:[\\/][^\s\\/:"'`()<>]+)+[\\/]?/g, "<path>")
    .replace(/(["'`])([^"'`\n]{0,200})\1/g, (whole, quote: string, inner: string) => (/^[A-Za-z_$][\w$]{0,40}$/.test(inner) ? whole : `${quote}…${quote}`))
    .replace(/\b[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** The step's name without its tool server's prefix; "turn" for a failed turn. */
export const stepName = (tool: string | undefined): string => (tool ? tool.replace(OWN_TOOL, "").slice(0, 200) || tool.slice(0, 200) : "turn");

/** The fingerprint of one error: its first line made general, the step, and Seira's frame nearest the error. */
export function errorFingerprint(facts: ErrorFacts): ErrorFingerprint {
  const head = facts.text.split("\n").find((line) => line.trim() && !STACK_LINE.test(line)) ?? "";
  const frame = seiraFrame(facts.text);
  return { kind: errorKind(head) || "error", step: stepName(facts.tool), ...(frame ? { frame } : {}) };
}

/** What the person who may send a draft reads (server/routes/bug-reports.ts). The text is the issue as it will be published. */
export interface BugDraftView {
  id: string;
  from: "error" | "devs";
  by?: string;
  state: "offer" | "saved" | "sent" | "joined" | "opened";
  issue?: number;
  title: string;
  /** "What happened", written by the bot. */
  description: string;
  /** The rest of the issue: versions, the AI, recent activity, all cleaned. */
  diagnostics: string;
  /** The "What's included" list. */
  included: { version: string; platform: string; model?: string; activity: number };
  /** The relay takes the report in one click. False: the person opens a prefilled issue form and submits it there. */
  direct: boolean;
  /** A prefilled issue form with the same text, made on this machine. */
  formUrl: string;
  /** An open report this app sent about the same error: this one is added to it. A report of another person carries only its public issue number. */
  same?: { issue?: number; title?: string; at?: number };
}

/** A public issue on the Seira repository. */
export const bugIssueUrl = (issue: number): string => `https://github.com/seira-bot/seira/issues/${issue}`;
